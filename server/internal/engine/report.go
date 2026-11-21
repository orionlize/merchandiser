package engine

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/shopspring/decimal"

	"merchandiser/server/internal/store"
	"merchandiser/server/internal/util"
)

// DailyReport summarises yesterday (server time zone) for the push channels:
// PnL across tasks, fills and failures, and the best / worst task.
func (e *Engine) DailyReport(ctx context.Context) (string, string) {
	todayStart := util.StartOfTodayMs()
	y := time.UnixMilli(todayStart).AddDate(0, 0, -1)
	yStart := y.UnixMilli()
	title := "每日报告 " + y.Format("01-02")
	tasks, err := store.Tasks(ctx, e.DB)
	if err != nil {
		return title, "读取任务失败：" + err.Error()
	}
	total := decimal.Zero
	type tp struct {
		name string
		pnl  decimal.Decimal
	}
	var best, worst *tp
	counted := 0
	for _, t := range tasks {
		if t.Status == "stopped" && (t.StoppedAt == nil || *t.StoppedAt < yStart) {
			continue
		}
		end, err1 := store.TaskPnlAt(ctx, e.DB, t.ID, todayStart)
		start, err2 := store.TaskPnlAt(ctx, e.DB, t.ID, yStart)
		if err1 != nil || err2 != nil {
			continue
		}
		d := end.Sub(start)
		total = total.Add(d)
		counted++
		cur := &tp{t.Name, d}
		if best == nil || d.GreaterThan(best.pnl) {
			best = cur
		}
		if worst == nil || d.LessThan(worst.pnl) {
			worst = cur
		}
	}
	fills, _ := store.Count(ctx, e.DB, "SELECT COUNT(*) FROM orders WHERE ts >= ? AND ts < ? AND status IN ('filled','partial')", yStart, todayStart)
	failed, _ := store.Count(ctx, e.DB, "SELECT COUNT(*) FROM orders WHERE ts >= ? AND ts < ? AND status = 'failed'", yStart, todayStart)
	alerts, _ := store.Count(ctx, e.DB, "SELECT COUNT(*) FROM alerts WHERE ts >= ? AND ts < ? AND level IN ('warn','error')", yStart, todayStart)
	var b strings.Builder
	fmt.Fprintf(&b, "跟单盈亏 %s USDT\n", signed(total))
	fmt.Fprintf(&b, "运行任务 %d 个，成交 %d 笔，失败 %d 笔，告警 %d 条", e.RunningCount(), fills, failed, alerts)
	if counted > 1 && best != nil && worst != nil {
		fmt.Fprintf(&b, "\n最佳：%s %s\n最差：%s %s", best.name, signed(best.pnl), worst.name, signed(worst.pnl))
	} else if best != nil {
		fmt.Fprintf(&b, "\n%s %s", best.name, signed(best.pnl))
	}
	return title, b.String()
}

// signed formats a USDT amount with an explicit sign and two decimals.
func signed(d decimal.Decimal) string {
	v := d.RoundBank(2).StringFixed(2)
	if d.IsPositive() {
		return "+" + v
	}
	return v
}
