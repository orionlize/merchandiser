//go:build !unix

package leader

import "os"

// No advisory locking outside unix; the server runs unguarded there.
func tryLock(*os.File) (bool, error) { return true, nil }
