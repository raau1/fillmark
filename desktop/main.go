// Fillmark desktop launcher.
//
// One executable that contains the whole web app. It serves the app on the
// loopback interface only (127.0.0.1) and shows it in its own window using the
// Microsoft Edge engine that is part of Windows (Chrome is used if Edge is
// missing). Documents are never uploaded anywhere; the window and its saved
// projects live in a separate browser profile under %LOCALAPPDATA%\Fillmark.
//
// Usage:
//
//	Fillmark.exe [file.pdf | project.fillmark ...]
//	Fillmark.exe --install     install for the current user (no admin rights needed)
//	Fillmark.exe --uninstall   remove shortcuts, file associations and the program
//	Fillmark.exe --portable    run without offering to install
//	Fillmark.exe --serve       (testing) serve without opening a window, print the URL
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:dist
var distFS embed.FS

const (
	appName    = "Fillmark"
	appVersion = "0.3.0"
	projectExt = ".fillmark"
)

// Earlier test builds of this app were called InkWell and Casilla (newest first).
// Their installations are migrated and their project files still open.
var (
	legacyNames       = []string{"InkWell", "Casilla"}
	legacyProjectExts = []string{".inkwell", ".casilla"}
)

func isProjectExt(ext string) bool {
	if ext == projectExt {
		return true
	}
	for _, e := range legacyProjectExts {
		if ext == e {
			return true
		}
	}
	return false
}

// Fixed port first: the browser keeps saved projects per origin (address + port).
var ports = []string{"47813", "47814", "47815", "47816", "47817"}

type runInfo struct {
	Addr  string `json:"addr"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func runFile() string { return filepath.Join(dataDir(), "run.json") }

func main() {
	var files []string
	opts := map[string]bool{}
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "--") {
			opts[a] = true
		} else if a != "" {
			files = append(files, a)
		}
	}

	migrateLegacy()

	switch {
	case opts["--uninstall"]:
		uninstall()
		return
	case opts["--install"]:
		if exe, ok := install(true); ok {
			startDetached(exe, files)
		}
		return
	}

	if !opts["--portable"] && !opts["--serve"] && shouldOfferInstall() {
		switch offerInstall() {
		case installChosen:
			if exe, ok := install(false); ok {
				startDetached(exe, files)
				return
			}
		case installCancelled:
			return
		}
	}

	for _, f := range files {
		ext := strings.ToLower(filepath.Ext(f))
		if ext != ".pdf" && !isProjectExt(ext) {
			showError(fmt.Sprintf("Fillmark can open PDF documents (.pdf) and Fillmark projects (.fillmark).\n\n“%s” is neither.", filepath.Base(f)))
			return
		}
	}

	if !opts["--serve"] {
		if handOffToRunning(files) {
			return
		}
	}

	content, err := fs.Sub(distFS, "dist")
	if err != nil {
		showError("The program files are damaged: " + err.Error())
		return
	}
	s := NewServer(content)
	ln, err := s.Listen(ports)
	if err != nil {
		showError("Fillmark could not start its local window server: " + err.Error())
		return
	}
	go http.Serve(ln, s)

	_ = os.MkdirAll(dataDir(), 0o700)
	if b, err := json.Marshal(runInfo{Addr: s.addr, Token: s.token, PID: os.Getpid()}); err == nil {
		_ = os.WriteFile(runFile(), b, 0o600)
	}
	defer os.Remove(runFile())

	var urls []string
	for _, f := range files {
		id, err := s.AddFile(f)
		if err != nil {
			showError(fmt.Sprintf("“%s” could not be opened: %v", filepath.Base(f), err))
			continue
		}
		urls = append(urls, s.WindowURL(id))
	}
	if len(urls) == 0 {
		urls = []string{s.WindowURL("")}
	}

	if opts["--serve"] {
		for _, u := range urls {
			fmt.Println(u)
		}
	} else {
		for _, u := range urls {
			if err := openWindow(u); err != nil {
				showError(err.Error())
				return
			}
		}
	}
	go s.Supervise(2 * time.Second)
	<-s.Done()
}

// handOffToRunning passes the files to a Fillmark that is already running and opens
// a window there. Returns false when no instance is running.
func readRunInfo() *runInfo {
	b, err := os.ReadFile(runFile())
	if err != nil {
		return nil
	}
	var ri runInfo
	if json.Unmarshal(b, &ri) != nil || ri.Addr == "" || ri.Token == "" {
		return nil
	}
	return &ri
}

func pingRunning(ri *runInfo) bool {
	if ri == nil {
		return false
	}
	req, _ := http.NewRequest(http.MethodGet, "http://"+ri.Addr+"/__ping", nil)
	req.Header.Set("X-Fillmark-Token", ri.Token)
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func handOffToRunning(files []string) bool {
	ri := readRunInfo()
	if !pingRunning(ri) {
		return false
	}
	client := &http.Client{Timeout: 10 * time.Second}
	base := "http://" + ri.Addr + "/?t=" + ri.Token
	if len(files) == 0 {
		return openWindow(base) == nil
	}
	for _, f := range files {
		abs, _ := filepath.Abs(f)
		payload, _ := json.Marshal(map[string]string{"path": abs})
		body := strings.NewReader(string(payload))
		req, _ := http.NewRequest(http.MethodPost, "http://"+ri.Addr+"/__open", body)
		req.Header.Set("X-Fillmark-Token", ri.Token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return false
		}
		var out struct {
			URL string `json:"url"`
		}
		ok := resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(&out) == nil
		resp.Body.Close()
		if !ok {
			showError(fmt.Sprintf("“%s” could not be opened.", filepath.Base(f)))
			continue
		}
		_ = openWindow(out.URL)
	}
	return true
}
