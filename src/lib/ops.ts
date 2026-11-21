// Human labels of server commands, for the two-step prompt and the audit log.

const LABELS: Record<string, [string, string]> = {
  unlock_app: ["解锁界面", "Unlock"],
  lock_app: ["锁定界面", "Lock"],
  unlock_secrets: ["解锁密钥库", "Unlock key file"],
  save_connection: ["保存交易账户", "Save account"],
  delete_connection: ["删除交易账户", "Delete account"],
  switch_one_way: ["切换单向持仓", "Switch to one-way"],
  close_all_positions: ["一键平仓", "Close all"],
  emergency_stop: ["全局急停", "Emergency stop"],
  release_estop: ["解除急停", "Release e-stop"],
  add_source: ["添加信号源", "Add source"],
  delete_source: ["删除信号源", "Delete source"],
  create_task: ["新建任务", "Create task"],
  update_task: ["修改任务", "Edit task"],
  delete_task: ["删除任务", "Delete task"],
  start_task: ["启动任务", "Start task"],
  resume_task: ["恢复任务", "Resume task"],
  pause_task: ["暂停任务", "Pause task"],
  stop_task: ["停止任务", "Stop task"],
  reconcile_task: ["立即对账", "Reconcile"],
  task_action: ["任务操作", "Task action"],
  plaza_favorite: ["关注钱包", "Favourite wallet"],
  paper_trade: ["模拟账户下单", "Paper trade"],
  set_notify: ["修改通知渠道", "Edit notifications"],
  test_notify: ["测试通知", "Test notification"],
  set_settings: ["修改设置", "Edit settings"],
  set_lock_password: ["修改应用锁", "Edit app lock"],
  set_symbol_override: ["修改品种映射", "Edit symbol map"],
  regenerate_symbol_map: ["重建品种映射", "Rebuild symbol map"],
  export_config: ["导出配置", "Export config"],
  import_config: ["导入配置", "Import config"],
  totp_setup: ["生成两步验证密钥", "Set up 2FA"],
  totp_enable: ["开启两步验证", "Enable 2FA"],
  totp_disable: ["关闭两步验证", "Disable 2FA"],
  totp_recovery_regen: ["重新生成恢复码", "New recovery codes"],
};

export function opLabel(cmd: string, en: boolean): string {
  const l = LABELS[cmd];
  return l ? l[en ? 1 : 0] : cmd;
}

/** The sensitive operations as shown in settings, in display order. */
export const SENSITIVE_GROUPS: { zh: string; en: string; cmds: string[] }[] = [
  { zh: "解锁界面", en: "Unlocking the UI", cmds: ["unlock_app"] },
  { zh: "添加、修改、删除交易账户", en: "Adding, editing or deleting accounts", cmds: ["save_connection", "delete_connection"] },
  { zh: "一键平仓", en: "Close all", cmds: ["close_all_positions"] },
  { zh: "删除任务", en: "Deleting tasks", cmds: ["delete_task"] },
  { zh: "修改应用锁与通知渠道", en: "App lock and notification channels", cmds: ["set_lock_password", "set_notify"] },
  { zh: "导入配置", en: "Importing a config", cmds: ["import_config"] },
  { zh: "关闭两步验证", en: "Turning 2FA off", cmds: ["totp_disable", "totp_recovery_regen"] },
];
