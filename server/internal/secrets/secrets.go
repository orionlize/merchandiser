// Package secrets keeps venue credentials in a file encrypted with a key
// derived (Argon2id) from a master password. The password comes from the
// environment at start-up, or from the UI's unlock prompt; until then the
// store is locked and no task can start. Plain secrets never leave the
// server. The file format matches the desktop build's fallback store, so an
// existing secrets.enc can be reused.
package secrets

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"

	"merchandiser/server/internal/errs"
	"merchandiser/server/internal/model"
)

// Backend is reported to the UI; only the encrypted file exists server-side.
const Backend = "encrypted_file"

type Store struct {
	file  string
	mu    sync.RWMutex
	key   *[32]byte
	salt  []byte
	cache map[string]model.Credentials
}

type fileFormat struct {
	Salt  string `json:"salt"`
	Nonce string `json:"nonce"`
	Data  string `json:"data"`
}

func New(dataDir string) *Store {
	return &Store{file: filepath.Join(dataDir, "secrets.enc"), cache: map[string]model.Credentials{}}
}

// Locked reports whether the master password is still needed.
func (s *Store) Locked() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.key == nil
}

func (s *Store) Initialized() bool {
	_, err := os.Stat(s.file)
	return err == nil
}

func derive(password string, salt []byte) [32]byte {
	// Argon2id with the argon2 crate's defaults (m=19456 KiB, t=2, p=1).
	k := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	var out [32]byte
	copy(out[:], k)
	return out
}

// Unlock opens the file with the password, or creates it on first use.
func (s *Store) Unlock(password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.file)
	if err == nil {
		var f fileFormat
		if err := json.Unmarshal(raw, &f); err != nil {
			return errs.Msg("密钥文件损坏: %v", err)
		}
		salt, err := hex.DecodeString(f.Salt)
		if err != nil {
			return errs.Msg("密钥文件损坏: %v", err)
		}
		key := derive(password, salt)
		m, err := decrypt(&key, &f)
		if err != nil {
			return err
		}
		s.cache, s.key, s.salt = m, &key, salt
		return nil
	}
	if !os.IsNotExist(err) {
		return errs.Msg("读取密钥文件失败: %v", err)
	}
	if len([]rune(password)) < 4 {
		return errs.Msg("主密码至少 4 位")
	}
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key := derive(password, salt)
	s.key, s.salt = &key, salt
	return s.persistLocked()
}

func (s *Store) Put(id string, c model.Credentials) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == nil {
		return errs.Msg("密钥文件未解锁")
	}
	s.cache[id] = c
	return s.persistLocked()
}

func (s *Store) Get(id string) (model.Credentials, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if c, ok := s.cache[id]; ok {
		return c, nil
	}
	if s.key == nil {
		return model.Credentials{}, errs.Msg("密钥文件未解锁")
	}
	return model.Credentials{}, errs.Msg("未找到连接 %s 的凭证", id)
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cache, id)
	if s.key == nil {
		return nil
	}
	return s.persistLocked()
}

func (s *Store) persistLocked() error {
	aead, err := chacha20poly1305.NewX(s.key[:])
	if err != nil {
		return err
	}
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	_, _ = rand.Read(nonce)
	plain, err := json.Marshal(s.cache)
	if err != nil {
		return err
	}
	data := aead.Seal(nil, nonce, plain, nil)
	f := fileFormat{Salt: hex.EncodeToString(s.salt), Nonce: hex.EncodeToString(nonce), Data: hex.EncodeToString(data)}
	b, _ := json.Marshal(f)
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return errs.Msg("写入密钥文件失败: %v", err)
	}
	return os.Rename(tmp, s.file)
}

func decrypt(key *[32]byte, f *fileFormat) (map[string]model.Credentials, error) {
	aead, err := chacha20poly1305.NewX(key[:])
	if err != nil {
		return nil, err
	}
	nonce, err1 := hex.DecodeString(f.Nonce)
	data, err2 := hex.DecodeString(f.Data)
	if err1 != nil || err2 != nil || len(nonce) != chacha20poly1305.NonceSizeX {
		return nil, errs.Msg("密钥文件损坏")
	}
	plain, err := aead.Open(nil, nonce, data, nil)
	if err != nil {
		return nil, errs.Msg("主密码错误")
	}
	m := map[string]model.Credentials{}
	if err := json.Unmarshal(plain, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// ---------- app-lock password hashing (PHC string, Argon2id) ----------

var b64 = base64.RawStdEncoding

func HashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	h := argon2.IDKey([]byte(pw), salt, 2, 19456, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=19456,t=2,p=1$%s$%s", b64.EncodeToString(salt), b64.EncodeToString(h)), nil
}

func VerifyPassword(pw, phc string) bool {
	parts := strings.Split(phc, "$")
	// ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
