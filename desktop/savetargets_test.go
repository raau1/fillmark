package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveBackToOpenedProject(t *testing.T) {
	s := testServer()
	s.stateDir = t.TempDir()
	dir := t.TempDir()
	proj := filepath.Join(dir, "Paciente Ñ.fillmark")
	orig := `{"format":"pdf-form-filler-project","version":1,"project":{}}`
	if err := os.WriteFile(proj, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	tok := map[string]string{"X-Fillmark-Token": s.token}
	save := func(p, body string, hdr map[string]string) int {
		return do(s, "POST", "/__save?path="+url.QueryEscape(p), strings.NewReader(body), hdr).Code
	}
	updated := `{"format":"pdf-form-filler-project","version":1,"project":{"answers":"nuevas"}}`

	// not opened yet → refused
	if c := save(proj, updated, tok); c != 403 {
		t.Fatalf("saving to a file that was never opened: %d", c)
	}
	// opened from Explorer → the window learns its path and may save back
	id, err := s.AddFile(proj)
	if err != nil {
		t.Fatal(err)
	}
	w := do(s, "GET", "/__file/"+id, nil, tok)
	if got, _ := url.PathUnescape(w.Header().Get("X-Fillmark-Path")); got != proj {
		t.Fatalf("path header %q", got)
	}
	if c := save(proj, updated, nil); c != 403 {
		t.Fatalf("save without token: %d", c)
	}
	if c := save(proj, "not a project", tok); c != 400 {
		t.Fatalf("garbage body: %d", c)
	}
	if c := save(proj, updated, tok); c != 204 {
		t.Fatalf("save: %d", c)
	}
	if b, _ := os.ReadFile(proj); string(b) != updated {
		t.Fatalf("file not updated: %s", b)
	}
	if _, err := os.Stat(proj + ".saving"); !os.IsNotExist(err) {
		t.Fatal("temporary file left behind")
	}
	// remembered across restarts (new server, same data folder)
	s2 := testServer()
	s2.stateDir = s.stateDir
	if !s2.saveAllowed(proj) {
		t.Fatal("save target should survive a restart")
	}
	// never anything but project files
	pdf := filepath.Join(dir, "form.pdf")
	os.WriteFile(pdf, []byte("%PDF-1.7"), 0o600)
	if _, err := s.AddFile(pdf); err != nil {
		t.Fatal(err)
	}
	if c := save(pdf, updated, tok); c != 403 {
		t.Fatalf("saving over a PDF must be refused: %d", c)
	}
	other := filepath.Join(dir, "other.fillmark")
	if c := save(other, updated, tok); c != 403 {
		t.Fatalf("saving to a project file that was never opened: %d", c)
	}
	if c := save("relative.fillmark", updated, tok); c != 403 {
		t.Fatalf("relative path: %d", c)
	}
}
