package main

type installChoice int

const (
	installChosen installChoice = iota
	runWithoutInstalling
	installCancelled
)
