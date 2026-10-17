//go:build windows

package main

// Per-user installation (no administrator rights, nothing outside the user's
// profile): program in %LOCALAPPDATA%\Programs\Fillmark, Start-menu and desktop
// shortcuts, "Open with Fillmark" for PDFs, double-click for .fillmark projects,
// and an entry in Settings > Apps for uninstalling.

import (
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

//go:embed fillmark.ico
var iconBytes []byte

const (
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Fillmark`
	classes      = `Software\Classes`
	progProject  = "Fillmark.Project"
	progPDF      = "Fillmark.PDF"
)

func installDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", appName)
}

func installedExe() string { return filepath.Join(installDir(), appName+".exe") }

func currentExe() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return p
}

func samePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }

func skipOfferFile() string { return filepath.Join(dataDir(), "run-without-installing") }

func shouldOfferInstall() bool {
	if samePath(currentExe(), installedExe()) {
		return false
	}
	if _, err := os.Stat(skipOfferFile()); err == nil {
		return false
	}
	return true
}

func offerInstall() installChoice {
	_, err := os.Stat(installedExe())
	update := err == nil
	var msg string
	if update {
		msg = tr(
			"Fillmark is already installed on this computer.\n\nYes: update the installed copy with this version.\nNo: just run this copy now.",
			"Fillmark ya está instalado en este ordenador.\n\nSí: actualizar la copia instalada con esta versión.\nNo: solo ejecutar esta copia ahora.")
	} else {
		msg = tr(
			"Install Fillmark on this computer?\n\n• Adds Fillmark to the Start menu and the desktop\n• Lets you open PDFs with Fillmark (right-click > Open with)\n• Opens .fillmark project files with a double-click\n\nNo administrator rights are needed. You can uninstall it from Settings > Apps.\n\nYes: install.   No: just run it this time.",
			"¿Instalar Fillmark en este ordenador?\n\n• Añade Fillmark al menú Inicio y al escritorio\n• Permite abrir PDF con Fillmark (clic derecho > Abrir con)\n• Abre los proyectos .fillmark con doble clic\n\nNo hacen falta permisos de administrador. Se puede desinstalar desde Configuración > Aplicaciones.\n\nSí: instalar.   No: solo ejecutarlo esta vez.")
	}
	switch messageBox(appName, msg, mbYesNoCancel|mbIconQuestion) {
	case idYes:
		return installChosen
	case idNo:
		if !update {
			_ = os.MkdirAll(dataDir(), 0o700)
			_ = os.WriteFile(skipOfferFile(), []byte("The user chose to run Fillmark without installing. Delete this file to be asked again.\n"), 0o600)
		}
		return runWithoutInstalling
	default:
		return installCancelled
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Remove(dst)
	return os.Rename(tmp, dst)
}

// instanceRunning reports whether a Fillmark window server is active.
func instanceRunning() bool { return pingRunning(readRunInfo()) }

// install copies the program and registers it. Returns the installed exe path.
func install(explicit bool) (string, bool) {
	src := currentExe()
	dst := installedExe()
	if err := os.MkdirAll(installDir(), 0o755); err != nil {
		showError(tr("Could not create the program folder: ", "No se pudo crear la carpeta del programa: ") + err.Error())
		return "", false
	}
	if !samePath(src, dst) {
		if err := copyFile(src, dst); err != nil {
			if instanceRunning() {
				showError(tr("Close all Fillmark windows and try again.", "Cierra todas las ventanas de Fillmark y vuelve a intentarlo."))
			} else {
				showError(tr("Could not copy Fillmark to its program folder: ", "No se pudo copiar Fillmark a su carpeta: ") + err.Error())
			}
			return "", false
		}
	}
	icon := filepath.Join(installDir(), "fillmark.ico")
	_ = os.WriteFile(icon, iconBytes, 0o644)

	var problems []string
	note := func(err error) {
		if err != nil {
			problems = append(problems, err.Error())
		}
	}

	// shortcuts
	if dir, err := knownFolder(&folderPrograms); err == nil {
		note(createShortcut(filepath.Join(dir, appName+".lnk"), dst, installDir(), icon, tr("Fill in PDF forms", "Rellenar formularios PDF")))
	} else {
		note(err)
	}
	if dir, err := knownFolder(&folderDesktop); err == nil {
		note(createShortcut(filepath.Join(dir, appName+".lnk"), dst, installDir(), icon, tr("Fill in PDF forms", "Rellenar formularios PDF")))
	} else {
		note(err)
	}

	open := fmt.Sprintf(`"%s" "%%1"`, dst)
	// .fillmark project files open with Fillmark on double-click
	for _, ext := range append([]string{projectExt}, legacyProjectExts...) {
		note(regSetString(classes+`\`+ext, "", progProject))
		note(regSetString(classes+`\Applications\Fillmark.exe\SupportedTypes`, ext, ""))
	}
	note(regSetString(classes+`\`+progProject, "", tr("Fillmark project", "Proyecto de Fillmark")))
	note(regSetString(classes+`\`+progProject+`\DefaultIcon`, "", icon))
	note(regSetString(classes+`\`+progProject+`\shell\open\command`, "", open))
	// PDFs: offered in "Open with", without changing the default PDF program
	note(regSetString(classes+`\`+progPDF, "", tr("PDF document", "Documento PDF")))
	note(regSetString(classes+`\`+progPDF+`\DefaultIcon`, "", icon))
	note(regSetString(classes+`\`+progPDF+`\shell\open\command`, "", open))
	note(regSet(hkeyCurrentUser, classes+`\.pdf\OpenWithProgids`, progPDF, regNone, nil))
	note(regSetString(classes+`\Applications\Fillmark.exe`, "FriendlyAppName", appName))
	note(regSetString(classes+`\Applications\Fillmark.exe\shell\open\command`, "", open))
	note(regSetString(classes+`\Applications\Fillmark.exe\SupportedTypes`, ".pdf", ""))
	// Settings > Apps entry
	note(regSetString(uninstallKey, "DisplayName", appName))
	note(regSetString(uninstallKey, "DisplayVersion", appVersion))
	note(regSetString(uninstallKey, "Publisher", appName))
	note(regSetString(uninstallKey, "DisplayIcon", icon))
	note(regSetString(uninstallKey, "InstallLocation", installDir()))
	note(regSetString(uninstallKey, "UninstallString", fmt.Sprintf(`"%s" --uninstall`, dst)))
	note(regSetDWORD(uninstallKey, "NoModify", 1))
	note(regSetDWORD(uninstallKey, "NoRepair", 1))
	if st, err := os.Stat(dst); err == nil {
		note(regSetDWORD(uninstallKey, "EstimatedSize", uint32(st.Size()/1024)))
	}
	notifyAssociationsChanged()
	_ = os.Remove(skipOfferFile())

	if len(problems) > 0 {
		messageBox(appName, tr("Fillmark was installed, but some shortcuts or file associations could not be created:\n\n",
			"Fillmark se ha instalado, pero no se han podido crear algunos accesos directos o asociaciones de archivos:\n\n")+strings.Join(problems, "\n"), mbOK|mbIconWarning)
	} else if explicit {
		messageBox(appName, tr("Fillmark is installed. You will find it in the Start menu and on the desktop.",
			"Fillmark está instalado. Lo encontrarás en el menú Inicio y en el escritorio."), mbOK|mbIconInformation)
	}
	return dst, true
}

func uninstall() {
	if instanceRunning() {
		showError(tr("Close all Fillmark windows before uninstalling.", "Cierra todas las ventanas de Fillmark antes de desinstalar."))
		return
	}
	if messageBox(appName, tr("Remove Fillmark from this computer?", "¿Quitar Fillmark de este ordenador?"), mbYesNo|mbIconQuestion) != idYes {
		return
	}
	deleteData := messageBox(appName, tr(
		"Also delete the projects and answers saved by Fillmark on this computer?\n\nChoose No to keep them (they will be there if you install Fillmark again). Project files (.fillmark) and exported PDFs you saved elsewhere are never touched.",
		"¿Borrar también los proyectos y respuestas que Fillmark ha guardado en este ordenador?\n\nElige No para conservarlos (seguirán ahí si vuelves a instalar Fillmark). Los archivos de proyecto (.fillmark) y los PDF exportados que guardaste en otro sitio no se tocan nunca."),
		mbYesNo|mbIconWarning|mbDefButton2) == idYes

	for _, f := range []*guid{&folderPrograms, &folderDesktop} {
		if dir, err := knownFolder(f); err == nil {
			_ = os.Remove(filepath.Join(dir, appName+".lnk"))
		}
	}
	regDeleteTree(classes + `\` + progProject)
	regDeleteTree(classes + `\` + progPDF)
	regDeleteTree(classes + `\Applications\Fillmark.exe`)
	regDeleteValue(classes+`\.pdf\OpenWithProgids`, progPDF)
	for _, ext := range append([]string{projectExt}, legacyProjectExts...) {
		if regReadString(syscall.HKEY_CURRENT_USER, classes+`\`+ext, "") == progProject {
			regDeleteTree(classes + `\` + ext)
		}
	}
	regDeleteTree(uninstallKey)
	notifyAssociationsChanged()

	if deleteData {
		_ = os.RemoveAll(dataDir())
	}
	dir := installDir()
	if samePath(filepath.Dir(currentExe()), dir) {
		// a running program cannot delete itself: remove the folder a moment after exiting
		cmd := exec.Command("cmd.exe", "/c", "ping -n 3 127.0.0.1 >nul & rmdir /s /q \""+dir+"\"")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
		_ = cmd.Start()
	} else {
		_ = os.RemoveAll(dir)
	}
	messageBox(appName, tr("Fillmark has been removed.", "Fillmark se ha desinstalado."), mbOK|mbIconInformation)
}

func startDetached(exe string, files []string) {
	cmd := exec.Command(exe, files...)
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		showError(err.Error())
	}
}

// migrateLegacy takes over from earlier test builds of this app (see legacyNames):
// saved projects are kept by moving the most recent data folder (it holds the
// window's browser profile), and the old shortcuts, file associations,
// Settings > Apps entry and program folder are removed.
func migrateLegacy() {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return
	}
	changed := false
	for _, old := range legacyNames {
		oldData := filepath.Join(local, old)
		if _, err := os.Stat(oldData); err == nil {
			if _, err := os.Stat(dataDir()); os.IsNotExist(err) {
				_ = os.Remove(filepath.Join(oldData, "run.json"))
				_ = os.Rename(oldData, dataDir()) // fails harmlessly if the old app is still open
			}
		}
		oldUninstall := `Software\Microsoft\Windows\CurrentVersion\Uninstall\` + old
		if regReadString(syscall.HKEY_CURRENT_USER, oldUninstall, "DisplayName") == "" {
			continue
		}
		for _, f := range []*guid{&folderPrograms, &folderDesktop} {
			if dir, err := knownFolder(f); err == nil {
				_ = os.Remove(filepath.Join(dir, old+".lnk"))
			}
		}
		regDeleteTree(classes + `\` + old + `.Project`)
		regDeleteTree(classes + `\` + old + `.PDF`)
		regDeleteTree(classes + `\Applications\` + old + `.exe`)
		regDeleteValue(classes+`\.pdf\OpenWithProgids`, old+".PDF")
		for _, ext := range legacyProjectExts {
			if regReadString(syscall.HKEY_CURRENT_USER, classes+`\`+ext, "") == old+".Project" {
				_ = regSetString(classes+`\`+ext, "", progProject)
			}
		}
		regDeleteTree(oldUninstall)
		_ = os.RemoveAll(filepath.Join(local, "Programs", old))
		changed = true
	}
	if changed {
		notifyAssociationsChanged()
	}
}
