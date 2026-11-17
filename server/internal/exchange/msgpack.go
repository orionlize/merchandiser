package exchange

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
)

// OMap is an ordered map. Hyperliquid hashes the msgpack encoding of an
// action, so field order must match the reference SDK exactly; the same
// value is also sent as JSON, in the same order.
type OMap []KV

type KV struct {
	K string
	V any
}

func (m OMap) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, kv := range m {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(kv.K)
		b.Write(k)
		b.WriteByte(':')
		v, err := json.Marshal(kv.V)
		if err != nil {
			return nil, err
		}
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// msgpack encodes the subset of values actions use, with the most compact
// representation for each (as rmp-serde and the Python msgpack do).
func msgpack(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := mpWrite(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func mpWrite(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteByte(0xc0)
	case bool:
		if x {
			b.WriteByte(0xc3)
		} else {
			b.WriteByte(0xc2)
		}
	case string:
		n := len(x)
		switch {
		case n < 32:
			b.WriteByte(0xa0 | byte(n))
		case n < 256:
			b.WriteByte(0xd9)
			b.WriteByte(byte(n))
		case n < 65536:
			b.WriteByte(0xda)
			_ = binary.Write(b, binary.BigEndian, uint16(n))
		default:
			b.WriteByte(0xdb)
			_ = binary.Write(b, binary.BigEndian, uint32(n))
		}
		b.WriteString(x)
	case uint32:
		mpUint(b, uint64(x))
	case uint64:
		mpUint(b, x)
	case int:
		if x < 0 {
			return fmt.Errorf("msgpack: negative int unsupported")
		}
		mpUint(b, uint64(x))
	case OMap:
		mpLen(b, len(x), 0x80, 0xde, 0xdf)
		for _, kv := range x {
			if err := mpWrite(b, kv.K); err != nil {
				return err
			}
			if err := mpWrite(b, kv.V); err != nil {
				return err
			}
		}
	case []any:
		mpLen(b, len(x), 0x90, 0xdc, 0xdd)
		for _, e := range x {
			if err := mpWrite(b, e); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("msgpack: unsupported type %T", v)
	}
	return nil
}

func mpLen(b *bytes.Buffer, n int, fix, m16, m32 byte) {
	switch {
	case n < 16:
		b.WriteByte(fix | byte(n))
	case n < 65536:
		b.WriteByte(m16)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	default:
		b.WriteByte(m32)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	}
}

func mpUint(b *bytes.Buffer, n uint64) {
	switch {
	case n < 128:
		b.WriteByte(byte(n))
	case n < 256:
		b.WriteByte(0xcc)
		b.WriteByte(byte(n))
	case n < 65536:
		b.WriteByte(0xcd)
		_ = binary.Write(b, binary.BigEndian, uint16(n))
	case n < 1<<32:
		b.WriteByte(0xce)
		_ = binary.Write(b, binary.BigEndian, uint32(n))
	default:
		b.WriteByte(0xcf)
		_ = binary.Write(b, binary.BigEndian, n)
	}
}
