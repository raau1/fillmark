package main

import (
	"testing"
	"unsafe"
)

// A fake COM object laid out like the real thing: first word = vtable pointer.
func TestVtableEntry(t *testing.T) {
	var vtbl [32]uintptr
	for i := range vtbl {
		vtbl[i] = 0x1000 + uintptr(i)
	}
	obj := struct {
		vptr *[32]uintptr
		data [8]uintptr // object fields that must NOT be read as methods
	}{vptr: &vtbl}
	for i := range obj.data {
		obj.data[i] = 0xBAD
	}
	for _, idx := range []int{0, 2, 6, 7, 9, 17, 20} {
		if got := vtableEntry(unsafe.Pointer(&obj), idx); got != vtbl[idx] {
			t.Fatalf("method %d: got %#x, want %#x", idx, got, vtbl[idx])
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{{"0.3.1", "0.3.0", 1}, {"0.3.0", "0.3.0", 0}, {"0.2.9", "0.3.0", -1}, {"0.10.0", "0.9.9", 1}, {"1.0", "0.9.9", 1}, {"0.3", "0.3.0", 0}}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
