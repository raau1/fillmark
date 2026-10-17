//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	return filepath.Join(base, appName)
}

func showError(msg string) {
	messageBox(appName, msg, mbOK|mbIconError)
}

// findBrowser returns Microsoft Edge (part of Windows 10/11), or Chrome as a fallback.
func findBrowser() string {
	var candidates []string
	for _, exe := range []string{"msedge.exe", "chrome.exe"} {
		key := `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exe
		if p := regReadString(syscall.HKEY_LOCAL_MACHINE, key, ""); p != "" {
			candidates = append(candidates, p)
		}
		if p := regReadString(syscall.HKEY_CURRENT_USER, key, ""); p != "" {
			candidates = append(candidates, p)
		}
		for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
			root := os.Getenv(env)
			if root == "" {
				continue
			}
			if exe == "msedge.exe" {
				candidates = append(candidates, filepath.Join(root, `Microsoft\Edge\Application\msedge.exe`))
			} else {
				candidates = append(candidates, filepath.Join(root, `Google\Chrome\Application\chrome.exe`))
			}
		}
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// The Fillmark window uses its own browser profile (separate from your normal
// browsing), stored in %LOCALAPPDATA%\Fillmark\profile. Saved projects live there.
func ensureProfile(profile string) {
	prefs := filepath.Join(profile, "Default", "Preferences")
	if _, err := os.Stat(prefs); err == nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(prefs), 0o700)
	p := map[string]any{
		// ask where to save each exported PDF / project file
		"download":  map[string]any{"prompt_for_download": true},
		"browser":   map[string]any{"has_seen_welcome_page": true},
		"translate": map[string]any{"enabled": false},
		"profile":   map[string]any{"exit_type": "Normal", "exited_cleanly": true},
	}
	if b, err := json.Marshal(p); err == nil {
		_ = os.WriteFile(prefs, b, 0o600)
	}
}

func openWindow(u string) error {
	profile := filepath.Join(dataDir(), "profile")
	ensureProfile(profile)
	browser := findBrowser()
	if browser == "" {
		// last resort: the default browser (works, but without a dedicated window)
		if err := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", u).Start(); err != nil {
			return errors.New(tr(
				"Fillmark needs Microsoft Edge or Google Chrome to show its window, and neither was found.",
				"Fillmark necesita Microsoft Edge o Google Chrome para mostrar su ventana y no se ha encontrado ninguno."))
		}
		return nil
	}
	args := []string{
		"--app=" + u,
		"--user-data-dir=" + profile,
		"--profile-directory=Default",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-sync",
		"--disable-extensions",
		"--disable-background-networking",
		"--disable-features=Translate,msUndersideButton,msEdgeSidebarV2,msHubAppsMenu,msImplicitSignin,msEdgeShoppingUI",
		"--window-size=1440,920",
	}
	cmd := exec.Command(browser, args...)
	cmd.Dir = filepath.Dir(browser)
	return cmd.Start()
}
