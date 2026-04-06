// BLE 设备配置
export const BLE_CONFIG = {
  DEVICE_NAME: 'CarKey_BLE',
  SERVICE_UUID: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  CHARACTERISTIC_UUID: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  PIN_CODE: '123456'
};

// 控制命令
export const COMMANDS = {
  UNLOCK: 'UNLOCK',
  LOCK: 'LOCK',
  TRUNK: 'TRUNK'
};

// 命令描述
export const COMMAND_LABELS = {
  UNLOCK: '开锁',
  LOCK: '关锁',
  TRUNK: '开后备箱'
};

// 命令颜色
export const COMMAND_COLORS = {
  UNLOCK: '#22c55e',
  LOCK: '#ef4444',
  TRUNK: '#f59e0b'
};
