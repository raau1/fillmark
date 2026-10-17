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
	uninstallKey    = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Fillmark`
	classes         = `Software\Classes`
	progProject     = "Fillmark.Project"
	progPDF         = "Fillmark.PDF"
	capabilitiesKey = `Software\Fillmark\Capabilities`
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

// routeLaunch decides what a double-click on Fillmark.exe does. It returns true
// when this process has handed over to the installed copy (or the user cancelled)
// and must exit. No dialog ever asks the user to press "No" to open the app:
//   - running the installed copy: repair its Windows registration if needed, then open;
//   - running a downloaded copy, Fillmark not installed: one OK/Cancel question to install;
//   - downloaded copy newer than the installed one: update silently, then open;
//   - downloaded copy same or older: just open the installed Fillmark.
func routeLaunch(files []string) bool {
	dst := installedExe()
	if samePath(currentExe(), dst) {
		if regReadString(syscall.HKEY_CURRENT_USER, uninstallKey, "DisplayVersion") != appVersion {
			register(dst, false) // self-repair after an interrupted install or an update
		}
		return false
	}
	_, err := os.Stat(dst)
	installedVersion := regReadString(syscall.HKEY_CURRENT_USER, uninstallKey, "DisplayVersion")
	switch {
	case err != nil || installedVersion == "":
		msg := tr(
			"Fillmark will be installed for your Windows user:\n\n• in the Start menu and on the desktop\n• in \u201cOpen with\u201d when you right-click a PDF\n• .fillmark project files will open with a double-click\n\nNo administrator rights are needed. You can uninstall it any time from Settings > Apps.",
			"Fillmark se instalará para tu usuario de Windows:\n\n• en el menú Inicio y en el escritorio\n• en \u201cAbrir con\u201d al hacer clic derecho en un PDF\n• los proyectos .fillmark se abrirán con doble clic\n\nNo hacen falta permisos de administrador. Se puede desinstalar cuando quieras desde Configuración > Aplicaciones.")
		if messageBox(tr("Install Fillmark", "Instalar Fillmark"), msg, mbOKCancel|mbIconInformation) != idOK {
			return true
		}
		if exe, ok := install(); ok {
			messageBox(appName, tr(
				"Fillmark is installed.\n\nOpen it from the Start menu or the desktop, or right-click a PDF and choose Open with > Fillmark.\n\nYou can delete the file you downloaded.",
				"Fillmark está instalado.\n\nÁbrelo desde el menú Inicio o el escritorio, o haz clic derecho en un PDF y elige Abrir con > Fillmark.\n\nYa puedes borrar el archivo que descargaste."),
				mbOK|mbIconInformation)
			startDetached(exe, files)
		}
		return true
	case compareVersions(appVersion, installedVersion) > 0:
		if exe, ok := install(); ok {
			startDetached(exe, files)
		}
		return true
	default:
		startDetached(dst, files)
		return true
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

// install copies this program to its folder and registers it with Windows.
// Returns the installed exe path.
func install() (string, bool) {
	src := currentExe()
	dst := installedExe()
	if err := os.MkdirAll(installDir(), 0o755); err != nil {
		showError(tr("Could not create the program folder: ", "No se pudo crear la carpeta del programa: ") + err.Error())
		return "", false
	}
	if !samePath(src, dst) {
		if err := copyFile(src, dst); err != nil {
			if instanceRunning() {
				showError(tr("Fillmark is open. Close every Fillmark window, then run this file again to update it.",
					"Fillmark está abierto. Cierra todas sus ventanas y vuelve a ejecutar este archivo para actualizarlo."))
			} else {
				showError(tr("Could not copy Fillmark to its program folder: ", "No se pudo copiar Fillmark a su carpeta: ") + err.Error())
			}
			return "", false
		}
	}
	register(dst, true)
	return dst, true
}

// register creates the shortcuts and Windows registrations for the installed exe.
// Registry entries are written first (plain API calls); shortcuts last.
func register(dst string, reportProblems bool) {
	icon := filepath.Join(installDir(), "fillmark.ico")
	_ = os.WriteFile(icon, iconBytes, 0o644)

	var problems []string
	note := func(err error) {
		if err != nil {
			problems = append(problems, err.Error())
		}
	}
	open := fmt.Sprintf(`"%s" "%%1"`, dst)
	app := classes + `\Applications\Fillmark.exe`
	// .fillmark project files open with Fillmark on double-click
	for _, ext := range append([]string{projectExt}, legacyProjectExts...) {
		note(regSetString(classes+`\`+ext, "", progProject))
		note(regSetString(app+`\SupportedTypes`, ext, ""))
	}
	note(regSetString(classes+`\`+progProject, "", tr("Fillmark project", "Proyecto de Fillmark")))
	note(regSetString(classes+`\`+progProject+`\DefaultIcon`, "", icon))
	note(regSetString(classes+`\`+progProject+`\shell\open\command`, "", open))
	// PDFs: listed under "Open with", without changing the default PDF program
	note(regSetString(classes+`\`+progPDF, "", tr("PDF document", "Documento PDF")))
	note(regSetString(classes+`\`+progPDF, "FriendlyTypeName", tr("PDF document", "Documento PDF")))
	note(regSetString(classes+`\`+progPDF+`\DefaultIcon`, "", icon))
	note(regSetString(classes+`\`+progPDF+`\shell\open`, "FriendlyAppName", appName))
	note(regSetString(classes+`\`+progPDF+`\shell\open\command`, "", open))
	note(regSet(hkeyCurrentUser, classes+`\.pdf\OpenWithProgids`, progPDF, regNone, nil))
	note(regSet(hkeyCurrentUser, classes+`\.pdf\OpenWithList\Fillmark.exe`, "", regSZ, ""))
	note(regSetString(app, "FriendlyAppName", appName))
	note(regSetString(app+`\DefaultIcon`, "", icon))
	note(regSetString(app+`\shell\open\command`, "", open))
	note(regSetString(app+`\SupportedTypes`, ".pdf", ""))
	// "Default apps" in Settings knows about Fillmark (the user decides there)
	note(regSetString(capabilitiesKey, "ApplicationName", appName))
	note(regSetString(capabilitiesKey, "ApplicationDescription", tr("Fill in PDF forms", "Rellenar formularios PDF")))
	note(regSetString(capabilitiesKey, "ApplicationIcon", icon))
	note(regSetString(capabilitiesKey+`\FileAssociations`, ".pdf", progPDF))
	note(regSetString(capabilitiesKey+`\FileAssociations`, projectExt, progProject))
	note(regSetString(`Software\RegisteredApplications`, appName, capabilitiesKey))
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

	// shortcuts
	desc := tr("Fill in PDF forms", "Rellenar formularios PDF")
	for _, f := range []*guid{&folderPrograms, &folderDesktop} {
		if dir, err := knownFolder(f); err == nil {
			note(createShortcut(filepath.Join(dir, appName+".lnk"), dst, installDir(), icon, desc))
		} else {
			note(err)
		}
	}

	if reportProblems && len(problems) > 0 {
		messageBox(appName, tr("Fillmark was installed, but some shortcuts or file associations could not be created:\n\n",
			"Fillmark se ha instalado, pero no se han podido crear algunos accesos directos o asociaciones de archivos:\n\n")+strings.Join(problems, "\n"), mbOK|mbIconWarning)
	}
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
	regDeleteTree(classes + `\.pdf\OpenWithList\Fillmark.exe`)
	regDeleteValue(`Software\RegisteredApplications`, appName)
	regDeleteTree(`Software\Fillmark`)
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
	_ = os.Remove(filepath.Join(dataDir(), "run-without-installing")) // marker used by 0.3.0
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
