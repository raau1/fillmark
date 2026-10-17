package main

import "unsafe"

// vtableEntry returns the address of method `index` of a COM interface.
//
// A COM interface pointer points to an object whose FIRST WORD is a pointer to
// the method table (vtable); the method is the index-th word of that table.
// (Build 0.3.0 skipped the first dereference and read the object itself, which
// made the installer crash while creating the Start-menu shortcut.)
func vtableEntry(obj unsafe.Pointer, index int) uintptr {
	vtbl := *(**[1 << 10]uintptr)(obj)
	return vtbl[index]
}
