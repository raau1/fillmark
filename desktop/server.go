package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The app is served only on the loopback interface, to the window Fillmark opens.
// Static files are public (they contain no user data). The endpoints that hand
// over files from disk require a per-run secret token, and the Host header must
// be the loopback address (protects against DNS-rebinding attacks).

const (
	maxOpenBytes   = 150 << 20
	csp            = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	staleAfter     = 3 * time.Minute  // a window that stops sending heartbeats (minimised windows send one per minute)
	firstWindowMax = 3 * time.Minute  // give up if no window ever connects
	lastWindowWait = 4 * time.Second  // after the last window says goodbye
	fileKeep       = 30 * time.Minute // files handed to a window are forgotten after this
)

var mimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".wasm":  "application/wasm",
	".ttf":   "font/ttf",
	".otf":   "font/otf",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".txt":   "text/plain; charset=utf-8",
	".map":   "application/json",
}

type openFile struct {
	name  string
	path  string // absolute path on disk
	data  []byte
	added time.Time
}

type Server struct {
	content  fs.FS
	token    string
	stateDir string // where save-targets.json lives
	addr     string // host:port actually bound

	mu       sync.Mutex
	files    map[string]*openFile
	windows  map[string]time.Time
	gone     map[string]bool // windows that said goodbye (a late heartbeat must not revive them)
	seenAny  bool
	started  time.Time
	byeAt    time.Time
	quit     chan struct{}
	quitOnce sync.Once
}

func newToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func NewServer(content fs.FS) *Server {
	return &Server{
		content:  content,
		token:    newToken(),
		stateDir: dataDir(),
		files:    map[string]*openFile{},
		windows:  map[string]time.Time{},
		gone:     map[string]bool{},
		started:  time.Now(),
		quit:     make(chan struct{}),
	}
}

// Listen binds the first free port of the given list (a fixed port keeps the
// browser storage — saved projects — at the same origin across launches).
func (s *Server) Listen(ports []string) (net.Listener, error) {
	var last error
	for _, p := range ports {
		ln, err := net.Listen("tcp", "127.0.0.1:"+p)
		if err == nil {
			s.addr = ln.Addr().String()
			return ln, nil
		}
		last = err
	}
	return nil, last
}

func (s *Server) BaseURL() string { return "http://" + s.addr + "/" }

// WindowURL is the address a new window opens; openID optionally names a file to load.
func (s *Server) WindowURL(openID string) string {
	q := url.Values{}
	q.Set("t", s.token)
	if openID != "" {
		q.Set("open", openID)
	}
	return s.BaseURL() + "?" + q.Encode()
}

func (s *Server) Done() <-chan struct{} { return s.quit }

func (s *Server) stop() { s.quitOnce.Do(func() { close(s.quit) }) }

// AddFile reads a file from disk and returns an id a window can fetch it by.
func (s *Server) AddFile(p string) (string, error) {
	st, err := os.Stat(p)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", errors.New("not a file")
	}
	if st.Size() > maxOpenBytes {
		return "", errors.New("file is larger than 150 MB")
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if isProjectPath(abs) {
		s.rememberSaveTarget(abs) // the window may save back into this project file
	}
	id := newToken()[:16]
	s.mu.Lock()
	s.files[id] = &openFile{name: filepath.Base(p), path: abs, data: data, added: time.Now()}
	s.mu.Unlock()
	return id, nil
}

func (s *Server) hostOK(r *http.Request) bool {
	h := r.Host
	_, port, _ := net.SplitHostPort(s.addr)
	return h == s.addr || h == "localhost:"+port
}

func (s *Server) tokenOK(r *http.Request) bool {
	t := r.Header.Get("X-Fillmark-Token")
	if t == "" {
		t = r.URL.Query().Get("t")
	}
	return subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.hostOK(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")

	switch {
	case r.URL.Path == "/__ping":
		// used by a second Fillmark.exe to find this one; reveals nothing without the token
		if !s.tokenOK(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		h.Set("Cache-Control", "no-store")
		io.WriteString(w, "fillmark")
	case r.URL.Path == "/__open" && r.Method == http.MethodPost:
		s.handleOpen(w, r)
	case strings.HasPrefix(r.URL.Path, "/__file/"):
		s.handleFile(w, r)
	case r.URL.Path == "/__save":
		s.handleSave(w, r)
	case r.URL.Path == "/__alive" || r.URL.Path == "/__bye":
		s.handleLifecycle(w, r)
	case strings.HasPrefix(r.URL.Path, "/__"):
		http.NotFound(w, r)
	default:
		s.handleStatic(w, r)
	}
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p == "/" {
		p = "/index.html"
	}
	name := strings.TrimPrefix(p, "/")
	f, err := s.content.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(path.Ext(name))
	ct, ok := mimeTypes[ext]
	if !ok {
		ct = "application/octet-stream" // .gz language data, .bcmap, .pfb, .icc …
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	if ext == ".html" {
		h.Set("Content-Security-Policy", csp)
		h.Set("Cache-Control", "no-store")
	} else {
		h.Set("Cache-Control", "no-cache")
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(f)
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		w.Write(data)
		return
	}
	http.ServeContent(w, r, name, st.ModTime(), rs)
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	if !s.tokenOK(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil || req.Path == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	id, err := s.AddFile(req.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": id, "url": s.WindowURL(id)})
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	if !s.tokenOK(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/__file/")
	s.mu.Lock()
	f := s.files[id]
	s.mu.Unlock()
	if f == nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Fillmark-Name", url.PathEscape(f.name))
	if isProjectPath(f.path) {
		h.Set("X-Fillmark-Path", url.PathEscape(f.path))
	}
	w.Write(f.data)
}

func (s *Server) handleLifecycle(w http.ResponseWriter, r *http.Request) {
	if !s.tokenOK(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	win := r.URL.Query().Get("w")
	if win == "" || len(win) > 64 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	if r.URL.Path == "/__alive" {
		if !s.gone[win] {
			s.windows[win] = time.Now()
			s.seenAny = true
			s.byeAt = time.Time{}
		}
	} else {
		s.gone[win] = true
		delete(s.windows, win)
		if len(s.windows) == 0 {
			s.byeAt = time.Now()
		}
	}
	s.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// Supervise ends the server when no window is left, and forgets old files.
func (s *Server) Supervise(tick time.Duration) {
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-s.quit:
			return
		case now := <-t.C:
			if s.shouldQuit(now) {
				s.stop()
				return
			}
		}
	}
}

func (s *Server) shouldQuit(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, f := range s.files {
		if now.Sub(f.added) > fileKeep {
			delete(s.files, id)
		}
	}
	for id, last := range s.windows {
		if now.Sub(last) > staleAfter {
			delete(s.windows, id)
		}
	}
	if !s.seenAny {
		return now.Sub(s.started) > firstWindowMax
	}
	if len(s.windows) > 0 {
		return false
	}
	if !s.byeAt.IsZero() {
		return now.Sub(s.byeAt) > lastWindowWait
	}
	return true // all windows went stale
}
