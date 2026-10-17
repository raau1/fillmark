package main

// Saving back into project files that were opened from Explorer
// (double-click or "Open with"). The window may only overwrite files that the
// user opened in Fillmark that way — remembered in save-targets.json in the
// data folder, so it still works after a restart — and only project files
// (.fillmark and the earlier extensions), never PDFs or anything else.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

const (
	maxSaveBytes   = 400 << 20
	maxSaveTargets = 500
	projectHeader  = `{"format":"pdf-form-filler-project"`
)

var targetsMu sync.Mutex

func samePathOS(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func isProjectPath(p string) bool { return isProjectExt(strings.ToLower(filepath.Ext(p))) }

func (s *Server) targetsFile() string { return filepath.Join(s.stateDir, "save-targets.json") }

func (s *Server) loadTargets() []string {
	var list []string
	if b, err := os.ReadFile(s.targetsFile()); err == nil {
		_ = json.Unmarshal(b, &list)
	}
	return list
}

// rememberSaveTarget records a project file the user opened, so it may be saved back to.
func (s *Server) rememberSaveTarget(p string) {
	targetsMu.Lock()
	defer targetsMu.Unlock()
	list := s.loadTargets()
	out := make([]string, 0, len(list)+1)
	for _, x := range list {
		if !samePathOS(x, p) {
			out = append(out, x)
		}
	}
	out = append(out, p)
	if len(out) > maxSaveTargets {
		out = out[len(out)-maxSaveTargets:]
	}
	b, _ := json.Marshal(out)
	_ = os.MkdirAll(s.stateDir, 0o700)
	tmp := s.targetsFile() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.targetsFile())
	}
}

func (s *Server) saveAllowed(p string) bool {
	targetsMu.Lock()
	defer targetsMu.Unlock()
	for _, x := range s.loadTargets() {
		if samePathOS(x, p) {
			return true
		}
	}
	return false
}

// writeAtomic replaces a file without ever leaving it half-written.
func writeAtomic(p string, data []byte) error {
	tmp := p + ".saving"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// POST /__save?path=<absolute path>   body: the project file
func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.tokenOK(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" || !filepath.IsAbs(p) || !isProjectPath(p) || !s.saveAllowed(p) {
		http.Error(w, "this file cannot be saved from here", http.StatusForbidden)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxSaveBytes+1))
	if err != nil {
		http.Error(w, "could not read the data", http.StatusBadRequest)
		return
	}
	if len(data) > maxSaveBytes {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return
	}
	if !bytes.HasPrefix(bytes.TrimSpace(data), []byte(projectHeader)) {
		http.Error(w, "not a project file", http.StatusBadRequest)
		return
	}
	if err := writeAtomic(filepath.Clean(p), data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
