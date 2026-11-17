package util

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/shopspring/decimal"
)

// J is a loose view over decoded JSON (numbers kept as json.Number), in the
// spirit of serde_json::Value indexing: missing keys yield an empty J.
type J struct{ v any }

func ParseJ(b []byte) (J, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return J{}, err
	}
	return J{v}, nil
}

func JOf(v any) J { return J{v} }

func (j J) Raw() any { return j.v }

func (j J) Get(k string) J {
	if m, ok := j.v.(map[string]any); ok {
		return J{m[k]}
	}
	return J{}
}

// Has reports whether an object has key k (even if null).
func (j J) Has(k string) bool {
	if m, ok := j.v.(map[string]any); ok {
		_, ok := m[k]
		return ok
	}
	return false
}

func (j J) At(i int) J {
	if a, ok := j.v.([]any); ok && i >= 0 && i < len(a) {
		return J{a[i]}
	}
	return J{}
}

func (j J) Arr() []J {
	a, ok := j.v.([]any)
	if !ok {
		return nil
	}
	out := make([]J, len(a))
	for i, x := range a {
		out[i] = J{x}
	}
	return out
}

func (j J) Obj() map[string]J {
	m, ok := j.v.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]J, len(m))
	for k, x := range m {
		out[k] = J{x}
	}
	return out
}

func (j J) IsNull() bool { return j.v == nil }

// Str mirrors the old `jstr`: strings as-is, numbers and bools as text, else "".
func (j J) Str() string {
	switch x := j.v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return ""
}

// AsStr returns the value only when it is a JSON string.
func (j J) AsStr() (string, bool) {
	s, ok := j.v.(string)
	return s, ok
}

// Dec reads a string or number as a decimal (zero otherwise).
func (j J) Dec() decimal.Decimal {
	switch x := j.v.(type) {
	case string:
		d, err := decimal.NewFromString(strings.TrimSpace(x))
		if err != nil {
			return decimal.Zero
		}
		return d
	case json.Number:
		d, err := decimal.NewFromString(x.String())
		if err != nil {
			return decimal.Zero
		}
		return d
	}
	return decimal.Zero
}

func (j J) Bool() (bool, bool) {
	b, ok := j.v.(bool)
	return b, ok
}

func (j J) BoolOr(def bool) bool {
	if b, ok := j.v.(bool); ok {
		return b
	}
	return def
}

func (j J) Int() (int64, bool) {
	if n, ok := j.v.(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return i, true
		}
	}
	return 0, false
}

func (j J) Uint() (uint64, bool) {
	i, ok := j.Int()
	if !ok || i < 0 {
		return 0, false
	}
	return uint64(i), true
}

// String renders the value as JSON.
func (j J) String() string {
	b, _ := json.Marshal(j.v)
	return string(b)
}

// JDec is shorthand for j.Get(k).Dec().
func (j J) JDec(k string) decimal.Decimal { return j.Get(k).Dec() }

// JStr is shorthand for j.Get(k).Str().
func (j J) JStr(k string) string { return j.Get(k).Str() }
