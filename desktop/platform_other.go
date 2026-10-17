//go:build !windows

package main

// Non-Windows builds exist for development and automated testing of the
// launcher (the installer parts are Windows-only).

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func dataDir() string {
	if d := os.Getenv("FILLMARK_DATA_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "fillmark")
}

func openWindow(u string) error {
	if b := os.Getenv("FILLMARK_BROWSER"); b != "" {
		return exec.Command(b, "--app="+u, "--user-data-dir="+filepath.Join(dataDir(), "profile"), "--no-first-run").Start()
	}
	return exec.Command("xdg-open", u).Start()
}

func showError(msg string) { fmt.Fprintln(os.Stderr, "Fillmark:", msg) }
func install() (string, bool) {
	showError("installation is only available on Windows")
	return "", false
}
func uninstall()                           { showError("uninstallation is only available on Windows") }
func startDetached(exe string, f []string) { _ = exec.Command(exe, f...).Start() }

func migrateLegacy()            {}
func routeLaunch([]string) bool { return false }
