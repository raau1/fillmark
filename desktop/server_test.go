package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testServer() *Server {
	content := fstest.MapFS{
		"index.html":               {Data: []byte("<!doctype html><title>Fillmark</title>")},
		"assets/app.js":            {Data: []byte("console.log(1)")},
		"pdfjs/wasm/x.wasm":        {Data: []byte{0, 'a', 's', 'm'}},
		"ocr/lang/spa.traineddata": {Data: []byte{1, 2, 3}},
	}
	s := NewServer(content)
	s.addr = "127.0.0.1:47813"
	return s
}

func do(s *Server, method, target string, body io.Reader, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, body)
	r.Host = "127.0.0.1:47813"
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestStaticFilesAndHeaders(t *testing.T) {
	s := testServer()
	cases := map[string]string{
		"/":                         "text/html; charset=utf-8",
		"/assets/app.js":            "text/javascript; charset=utf-8",
		"/pdfjs/wasm/x.wasm":        "application/wasm",
		"/ocr/lang/spa.traineddata": "application/octet-stream",
	}
	for path, ct := range cases {
		w := do(s, "GET", path, nil, nil)
		if w.Code != 200 {
			t.Fatalf("%s: status %d", path, w.Code)
		}
		if got := w.Header().Get("Content-Type"); got != ct {
			t.Errorf("%s: content-type %q, want %q", path, got, ct)
		}
		if w.Header().Get("Content-Encoding") != "" {
			t.Errorf("%s: must not be content-encoded (the OCR engine gunzips itself)", path)
		}
	}
	w := do(s, "GET", "/", nil, nil)
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
		t.Error("index.html must carry the CSP that blocks third-party connections")
	}
	if do(s, "GET", "/../../etc/passwd", nil, nil).Code != 404 {
		t.Error("path traversal must not escape the embedded files")
	}
	if do(s, "GET", "/missing.js", nil, nil).Code != 404 {
		t.Error("missing file should 404")
	}
}

func TestRejectsForeignHost(t *testing.T) {
	s := testServer()
	r := httptest.NewRequest("GET", "/", nil)
	r.Host = "evil.example:47813" // DNS rebinding
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("foreign Host header must be rejected, got %d", w.Code)
	}
}

func TestOpenFileNeedsToken(t *testing.T) {
	s := testServer()
	dir := t.TempDir()
	p := filepath.Join(dir, "Ñandú paciente.pdf")
	if err := os.WriteFile(p, []byte("%PDF-1.7 test"), 0o600); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"path": p})
	if w := do(s, "POST", "/__open", bytes.NewReader(body), nil); w.Code != 403 {
		t.Fatalf("open without token: %d", w.Code)
	}
	w := do(s, "POST", "/__open", bytes.NewReader(body), map[string]string{"X-Fillmark-Token": s.token})
	if w.Code != 200 {
		t.Fatalf("open with token: %d %s", w.Code, w.Body.String())
	}
	var out struct{ ID, URL string }
	json.Unmarshal(w.Body.Bytes(), &out)
	if out.ID == "" || !strings.Contains(out.URL, "open="+out.ID) {
		t.Fatalf("bad response %+v", out)
	}
	if w := do(s, "GET", "/__file/"+out.ID, nil, nil); w.Code != 403 {
		t.Fatalf("file without token: %d", w.Code)
	}
	if w := do(s, "GET", "/__file/"+out.ID, nil, map[string]string{"X-Fillmark-Token": "wrong"}); w.Code != 403 {
		t.Fatalf("file with wrong token: %d", w.Code)
	}
	w = do(s, "GET", "/__file/"+out.ID, nil, map[string]string{"X-Fillmark-Token": s.token})
	if w.Code != 200 || w.Body.String() != "%PDF-1.7 test" {
		t.Fatalf("file with token: %d", w.Code)
	}
	if got := w.Header().Get("X-Fillmark-Name"); got != "%C3%91and%C3%BA%20paciente.pdf" {
		t.Errorf("name header %q", got)
	}
	if w := do(s, "GET", "/__ping", nil, nil); w.Code != 403 {
		t.Error("ping without token must not identify the server")
	}
	if w := do(s, "GET", "/__ping?t="+s.token, nil, nil); w.Body.String() != "fillmark" {
		t.Error("ping with token")
	}
}

func TestLifetime(t *testing.T) {
	s := testServer()
	t0 := s.started
	if s.shouldQuit(t0.Add(time.Minute)) {
		t.Fatal("should wait for the first window")
	}
	if !s.shouldQuit(t0.Add(firstWindowMax + time.Second)) {
		t.Fatal("should give up when no window ever connects")
	}
	s = testServer()
	tok := map[string]string{"X-Fillmark-Token": s.token}
	do(s, "GET", "/__alive?w=a", nil, tok)
	do(s, "GET", "/__alive?w=b", nil, tok)
	now := time.Now()
	if s.shouldQuit(now.Add(time.Minute)) {
		t.Fatal("windows are open (a minimised window beats once a minute)")
	}
	do(s, "POST", "/__bye?w=a&t="+s.token, nil, nil)
	if s.shouldQuit(time.Now().Add(10 * time.Second)) {
		t.Fatal("window b is still open")
	}
	do(s, "POST", "/__bye?w=b&t="+s.token, nil, nil)
	if s.shouldQuit(time.Now().Add(time.Second)) {
		t.Fatal("a reload re-registers within the grace period")
	}
	do(s, "GET", "/__alive?w=c", nil, tok) // the reloaded page
	if s.shouldQuit(time.Now().Add(10 * time.Second)) {
		t.Fatal("reloaded window is open")
	}
	do(s, "POST", "/__bye?w=c&t="+s.token, nil, nil)
	if !s.shouldQuit(time.Now().Add(lastWindowWait + time.Second)) {
		t.Fatal("should quit after the last window closed")
	}
	// a heartbeat that arrives after the goodbye (request race) does not revive the window
	s = testServer()
	do(s, "GET", "/__alive?w=r", nil, map[string]string{"X-Fillmark-Token": s.token})
	do(s, "POST", "/__bye?w=r&t="+s.token, nil, nil)
	do(s, "GET", "/__alive?w=r", nil, map[string]string{"X-Fillmark-Token": s.token})
	if !s.shouldQuit(time.Now().Add(lastWindowWait + time.Second)) {
		t.Fatal("late heartbeat revived a closed window")
	}
	// a crashed window (no goodbye) is dropped after it goes stale
	s = testServer()
	do(s, "GET", "/__alive?w=z", nil, map[string]string{"X-Fillmark-Token": s.token})
	if !s.shouldQuit(time.Now().Add(staleAfter + time.Second)) {
		t.Fatal("stale window should not keep the app alive")
	}
	// lifecycle calls need the token
	s = testServer()
	if w := do(s, "GET", "/__alive?w=x", nil, nil); w.Code != 403 {
		t.Fatal("alive without token")
	}
}

var _ = http.StatusOK
