package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
)

// Settings are app-wide preferences persisted in the settings table. Some
// fields (autostart, prevent_sleep) only matter to the desktop client and
// are stored here so every client sees the same values.
type Settings struct {
	Language         string `json:"language"`
	Theme            string `json:"theme"`
	Autostart        bool   `json:"autostart"`
	PreventSleep     bool   `json:"prevent_sleep"`
	AppLock          bool   `json:"app_lock"`
	IdleLockMinutes  uint32 `json:"idle_lock_minutes"`
	LogRetentionDays uint32 `json:"log_retention_days"`
	Notifications    bool   `json:"notifications"`
	CloseConfirmMode string `json:"close_confirm_mode"`
}

func DefaultSettings() Settings {
	return Settings{
		Language:         "zh",
		Theme:            "dark",
		PreventSleep:     true,
		IdleLockMinutes:  15,
		LogRetentionDays: 90,
		Notifications:    true,
		CloseConfirmMode: "word",
	}
}

func (s *Settings) UnmarshalJSON(b []byte) error {
	type plain Settings
	p := plain(DefaultSettings())
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = Settings(p)
	return nil
}

var (
	settingsMu sync.RWMutex
	settings   = DefaultSettings()
)

func SettingsCache() Settings {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	return settings
}

func LoadSettings(ctx context.Context, db *sql.DB) (Settings, error) {
	s := DefaultSettings()
	v, err := GetSetting(ctx, db, "app")
	if err != nil {
		return s, err
	}
	if v != nil {
		if err := json.Unmarshal([]byte(*v), &s); err != nil {
			s = DefaultSettings()
		}
	}
	settingsMu.Lock()
	settings = s
	settingsMu.Unlock()
	return s, nil
}

func SaveSettings(ctx context.Context, db *sql.DB, s Settings) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := SetSetting(ctx, db, "app", string(b)); err != nil {
		return err
	}
	settingsMu.Lock()
	settings = s
	settingsMu.Unlock()
	return nil
}
