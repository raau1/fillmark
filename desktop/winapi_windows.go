//go:build windows

package main

// Minimal Win32 bindings using only the standard library (syscall), so the
// launcher builds without third-party modules.

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW              = user32.NewProc("MessageBoxW")
	shell32                      = syscall.NewLazyDLL("shell32.dll")
	procSHGetKnownFolder         = shell32.NewProc("SHGetKnownFolderPath")
	procSHChangeNotify           = shell32.NewProc("SHChangeNotify")
	ole32                        = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx           = ole32.NewProc("CoInitializeEx")
	procCoUninitialize           = ole32.NewProc("CoUninitialize")
	procCoCreateInstance         = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree            = ole32.NewProc("CoTaskMemFree")
	advapi32                     = syscall.NewLazyDLL("advapi32.dll")
	procRegCreateKeyExW          = advapi32.NewProc("RegCreateKeyExW")
	procRegSetValueExW           = advapi32.NewProc("RegSetValueExW")
	procRegDeleteTreeW           = advapi32.NewProc("RegDeleteTreeW")
	procRegDeleteKeyValueW       = advapi32.NewProc("RegDeleteKeyValueW")
	procRegDeleteKeyW            = advapi32.NewProc("RegDeleteKeyW")
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procGetUserDefaultUILanguage = kernel32.NewProc("GetUserDefaultUILanguage")
)

const (
	mbOK              = 0x0
	mbYesNoCancel     = 0x3
	mbYesNo           = 0x4
	mbIconError       = 0x10
	mbIconQuestion    = 0x20
	mbIconWarning     = 0x30
	mbIconInformation = 0x40
	mbDefButton2      = 0x100
	mbSetForeground   = 0x10000
	idYes             = 6
	idNo              = 7

	hkeyCurrentUser  = 0x80000001
	hkeyLocalMachine = 0x80000002
	keyAllAccess     = 0xF003F
	regNone          = 0
	regSZ            = 1
	regDWORD         = 4
)

func messageBox(title, text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags|mbSetForeground)
	return int(r)
}

// Spanish dialogs when Windows is in Spanish, English otherwise.
func spanishUI() bool {
	r, _, _ := procGetUserDefaultUILanguage.Call()
	return r&0x3ff == 0x0a
}

func tr(en, es string) string {
	if spanishUI() {
		return es
	}
	return en
}

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	folderDesktop  = guid{0xB4BFCC3A, 0xDB2C, 0x424C, [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41}}
	folderPrograms = guid{0xA77F5D77, 0x2E2B, 0x44C3, [8]byte{0xA6, 0xA2, 0xAB, 0xA6, 0x01, 0x05, 0x4A, 0x51}}

	clsidShellLink  = guid{0x00021401, 0x0000, 0x0000, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIShellLinkW  = guid{0x000214F9, 0x0000, 0x0000, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidIPersistFile = guid{0x0000010B, 0x0000, 0x0000, [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
)

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	var s []uint16
	for ptr := unsafe.Pointer(p); ; ptr = unsafe.Add(ptr, 2) {
		c := *(*uint16)(ptr)
		if c == 0 {
			break
		}
		s = append(s, c)
	}
	return syscall.UTF16ToString(s)
}

// knownFolder resolves Desktop / Start-menu Programs, honouring redirection (e.g. OneDrive Desktop).
func knownFolder(id *guid) (string, error) {
	var p *uint16
	hr, _, _ := procSHGetKnownFolder.Call(uintptr(unsafe.Pointer(id)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if hr != 0 {
		return "", fmt.Errorf("SHGetKnownFolderPath failed: 0x%x", hr)
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return utf16PtrToString(p), nil
}

func notifyAssociationsChanged() {
	const shcneAssocChanged = 0x08000000
	procSHChangeNotify.Call(shcneAssocChanged, 0, 0, 0)
}

// ---- registry (HKEY_CURRENT_USER only: no administrator rights needed)

func regSet(root uintptr, key, name string, typ uint32, value any) error {
	k, _ := syscall.UTF16PtrFromString(key)
	var h syscall.Handle
	r, _, _ := procRegCreateKeyExW.Call(root, uintptr(unsafe.Pointer(k)), 0, 0, 0, keyAllAccess, 0, uintptr(unsafe.Pointer(&h)), 0)
	if r != 0 {
		return fmt.Errorf("RegCreateKeyEx %s: %d", key, r)
	}
	defer syscall.RegCloseKey(h)
	var namePtr *uint16
	if name != "" {
		namePtr, _ = syscall.UTF16PtrFromString(name)
	}
	var data unsafe.Pointer
	var size uint32
	switch v := value.(type) {
	case string:
		u, _ := syscall.UTF16FromString(v)
		data, size = unsafe.Pointer(&u[0]), uint32(len(u)*2)
		r, _, _ = procRegSetValueExW.Call(uintptr(h), uintptr(unsafe.Pointer(namePtr)), 0, uintptr(typ), uintptr(data), uintptr(size))
		runtime.KeepAlive(u)
	case uint32:
		d := v
		r, _, _ = procRegSetValueExW.Call(uintptr(h), uintptr(unsafe.Pointer(namePtr)), 0, uintptr(typ), uintptr(unsafe.Pointer(&d)), 4)
	case nil:
		r, _, _ = procRegSetValueExW.Call(uintptr(h), uintptr(unsafe.Pointer(namePtr)), 0, uintptr(typ), 0, 0)
	default:
		return errors.New("unsupported registry value")
	}
	if r != 0 {
		return fmt.Errorf("RegSetValueEx %s\\%s: %d", key, name, r)
	}
	return nil
}

func regSetString(key, name, value string) error {
	return regSet(hkeyCurrentUser, key, name, regSZ, value)
}
func regSetDWORD(key, name string, v uint32) error {
	return regSet(hkeyCurrentUser, key, name, regDWORD, v)
}

func regDeleteTree(key string) {
	k, _ := syscall.UTF16PtrFromString(key)
	procRegDeleteTreeW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(k)))
	procRegDeleteKeyW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(k)))
}

func regDeleteValue(key, name string) {
	k, _ := syscall.UTF16PtrFromString(key)
	n, _ := syscall.UTF16PtrFromString(name)
	procRegDeleteKeyValueW.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(k)), uintptr(unsafe.Pointer(n)))
}

// regReadString reads a string value (used to find the browser via App Paths).
func regReadString(root syscall.Handle, key, name string) string {
	k, _ := syscall.UTF16PtrFromString(key)
	var h syscall.Handle
	if syscall.RegOpenKeyEx(root, k, 0, syscall.KEY_READ, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	var namePtr *uint16
	if name != "" {
		namePtr, _ = syscall.UTF16PtrFromString(name)
	}
	var typ, size uint32
	if syscall.RegQueryValueEx(h, namePtr, nil, &typ, nil, &size) != nil || size == 0 {
		return ""
	}
	buf := make([]uint16, size/2+1)
	if syscall.RegQueryValueEx(h, namePtr, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &size) != nil {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

// ---- shortcuts through the Windows Shell (IShellLink), like any installer

// comCall invokes method `index` of a COM interface. COM objects live in memory
// owned by Windows (not the Go heap), so reading their vtable is safe.
func comCall(obj uintptr, index int, args ...uintptr) uintptr {
	vtbl := **(**[64]uintptr)(unsafe.Pointer(&obj))
	r, _, _ := syscall.SyscallN(vtbl[index], append([]uintptr{obj}, args...)...)
	return r
}

func createShortcut(lnkPath, target, workDir, iconPath, description string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const coinitApartmentThreaded = 0x2
	hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded)
	if hr != 0 && hr != 1 { // S_OK or S_FALSE (already initialised)
		return fmt.Errorf("CoInitializeEx: 0x%x", hr)
	}
	defer procCoUninitialize.Call()

	var link uintptr
	const clsctxInprocServer = 0x1
	hr, _, _ = procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidShellLink)), 0, clsctxInprocServer, uintptr(unsafe.Pointer(&iidIShellLinkW)), uintptr(unsafe.Pointer(&link)))
	if hr != 0 {
		return fmt.Errorf("CoCreateInstance(ShellLink): 0x%x", hr)
	}
	defer comCall(link, 2) // Release

	var keep [][]uint16 // keep the UTF-16 strings alive until the calls are done
	defer func() { runtime.KeepAlive(keep) }()
	p := func(s string) uintptr {
		u, _ := syscall.UTF16FromString(s)
		keep = append(keep, u)
		return uintptr(unsafe.Pointer(&u[0]))
	}
	// IShellLinkW vtable: 7 SetDescription, 9 SetWorkingDirectory, 17 SetIconLocation, 20 SetPath
	if hr := comCall(link, 20, p(target)); hr != 0 {
		return fmt.Errorf("SetPath: 0x%x", hr)
	}
	comCall(link, 9, p(workDir))
	comCall(link, 7, p(description))
	if iconPath != "" {
		comCall(link, 17, p(iconPath), 0)
	}
	var pf uintptr
	if hr := comCall(link, 0, uintptr(unsafe.Pointer(&iidIPersistFile)), uintptr(unsafe.Pointer(&pf))); hr != 0 {
		return fmt.Errorf("QueryInterface(IPersistFile): 0x%x", hr)
	}
	defer comCall(pf, 2)
	// IPersistFile vtable: 6 Save(pszFileName, fRemember)
	if hr := comCall(pf, 6, p(lnkPath), 1); hr != 0 {
		return fmt.Errorf("saving shortcut: 0x%x", hr)
	}
	return nil
}
