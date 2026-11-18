package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Backup writes a consistent copy of dir/merchandiser.db to
// dir/backups/merchandiser-<time>.db before the database is opened (and
// migrated), keeping the newest `keep` copies. Returns "" when there is no
// database yet.
func Backup(dir string, keep int) (string, error) {
	src := filepath.Join(dir, "merchandiser.db")
	if _, err := os.Stat(src); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	bdir := filepath.Join(dir, "backups")
	if err := os.MkdirAll(bdir, 0o700); err != nil {
		return "", err
	}
	dst := filepath.Join(bdir, "merchandiser-"+time.Now().UTC().Format("20060102-150405")+".db")
	db, err := sql.Open("sqlite", "file:"+src+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return "", err
	}
	defer db.Close()
	if _, err := db.Exec("VACUUM INTO ?", dst); err != nil {
		return "", fmt.Errorf("vacuum into %s: %w", dst, err)
	}
	ents, err := os.ReadDir(bdir)
	if err != nil {
		return dst, nil
	}
	var olds []string
	for _, e := range ents {
		if n := e.Name(); strings.HasPrefix(n, "merchandiser-") && strings.HasSuffix(n, ".db") {
			olds = append(olds, n)
		}
	}
	sort.Strings(olds)
	for len(olds) > keep {
		_ = os.Remove(filepath.Join(bdir, olds[0]))
		olds = olds[1:]
	}
	return dst, nil
}
