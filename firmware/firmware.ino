// ============================================================
// ESP32-C3 车钥匙蓝牙外挂 - 低功耗优化版
// 电源方案：5V/5600mAh 锂电池 + MCP1700-3302 LDO (3.3V)
// 低功耗策略：BLE Modem Sleep + 自动 Light Sleep
// ============================================================

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "esp_sleep.h"
#include "esp_pm.h"         // 电源管理：自动 Light Sleep
#include "esp_bt.h"         // BLE Modem Sleep
#include <Preferences.h>

// --- 日志宏定义 ---
#define APP_LOG(fmt, ...) Serial.printf("[%5lu.%03lu] " fmt "\n", millis() / 1000, millis() % 1000, ##__VA_ARGS__)

// --- 配置参数 ---
#define DEVICE_NAME "CarKey_BLE"


// 用于持久化存储的配置对象
Preferences preferences;
uint32_t devicePasskey = 123456;  // 当前配对密码
uint32_t authFailedCount = 0;     // 连续错误次数统计
unsigned long lockStartTime = 0;  // 锁定触发的系统时间戳
bool isLocked = false;            // 是否处于高防熔断隐身状态
#define LOCK_TIMEOUT_MS (3 * 60 * 1000) // 锁定惩罚 3 分钟

// GPIO 引脚定义 (ESP32-C3 推荐使用 GPIO 4-7, 18-21 避免与 BLE 冲突)
#define PIN_UNLOCK 4
#define PIN_LOCK 5
#define PIN_TRUNK 6
#define PIN_AUX 7

// BLE UUIDs
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// --- 全局变量 ---
BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;
bool isAuthenticated = false; // 新增：必须为 true 才能执行操作
unsigned long lastActivityTime = 0;

// --- 回调函数 ---
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
      // 绝对不能在此处做 isAuthenticated = false。
      // 因为 iOS 或带缓存的安卓快速重连时，NimBLE 的 onAuthenticationComplete 事件可能会比 onConnect 先行到达队列。
      // 如果这里重置，就会将刚刚底层握好的 true 冲刷掉，导致双重锁自闭。
      lastActivityTime = millis();
      APP_LOG("[SYS] Client Connected. Awaiting Commands...");
    };

    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      isAuthenticated = false; // 安全锁：设备断开后才重置为未认证
      APP_LOG("[SYS] Client Disconnected.");
      // 断开后，如果在惩罚锁定期，则保持底层的静默不播发
      if (!isLocked) {
        pServer->getAdvertising()->start();
      } else {
        APP_LOG("[SEC] Device is in LOCKOUT DEFENSE MODE. Advertising completely suppressed!");
      }
    }
};

class MyCharacteristicCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      // --- 【双重锁防线】强制拦截越权指令 ---
      if (!isAuthenticated) {
        APP_LOG("[WARN] CRITICAL: Unauthorized write attempt rejected! Kicking device.");
        pServer->disconnect(pServer->getConnId());
        return;
      }
      
      String value = pCharacteristic->getValue();
      lastActivityTime = millis();

      if (value.length() > 0) {
        APP_LOG("[ACTION] Command Received: %s", value.c_str());

        // 指令解析
        if (value.startsWith("SETPASS:")) {
          String passStr = value.substring(8);
          passStr.trim(); // 移除可能存在的换行符
          uint32_t newPass = passStr.toInt();
          
          // 确保新密码是合法的6位数范围 000000 ~ 999999
          if (newPass >= 0 && newPass <= 999999 && passStr.length() > 0) {
            devicePasskey = newPass;
            preferences.putUInt("passkey", devicePasskey);
            
            // 【安全强制】：修改密码后，暴力清除底层蓝牙缓存的所有配对白名单
            Preferences bondClear;
            if(bondClear.begin("nimble_bond", false)) { bondClear.clear(); bondClear.end(); }
            if(bondClear.begin("bt_config", false)) { bondClear.clear(); bondClear.end(); }
            
            APP_LOG("[AUTH] Passkey successfully changed to: %06d", devicePasskey);
            APP_LOG("[AUTH] Security Update: Old bonds cleared. Disconnecting to enforce re-pairing.");
            
            // 同步立即让蓝牙底层生效新密码（避免需要重启 ESP32 才生效）
            BLESecurity::setPassKey(true, devicePasskey);
            
            // 踢掉当前用户的连接，强迫其必须马上重新输入新密码进行配对
            pServer->disconnect(pServer->getConnId());
            
          } else {
            APP_LOG("[WARN] Invalid passkey. Use format SETPASS:XXXXXX");
          }
        } else if (value == "UNLOCK") {
          triggerAction(PIN_UNLOCK, "UNLOCK");
        } else if (value == "LOCK") {
          triggerAction(PIN_LOCK, "LOCK");
        } else if (value == "TRUNK") {
          triggerAction(PIN_TRUNK, "TRUNK");
        }
      }
    }

    void triggerAction(int pin, const char* action) {
      APP_LOG("[ACTION] Executing: %s (PIN %d pulled HIGH)", action, pin);
      digitalWrite(pin, HIGH);
      delay(100); // 模拟按键按下 0.5 秒
      digitalWrite(pin, LOW);
      APP_LOG("[ACTION] Completed.");
    }
};

// --- 安全回调 ---
class MySecurityCallbacks : public BLESecurityCallbacks {
  uint32_t onPassKeyRequest() {
    return devicePasskey; // 隐藏系统级反复索要密码的日志
  }
  void onPassKeyNotify(uint32_t pass_key) { }
  bool onConfirmPIN(uint32_t pass_key) { return true; }
  bool onSecurityRequest() { return true; }
#if defined(CONFIG_NIMBLE_ENABLED)
  void onAuthenticationComplete(ble_gap_conn_desc *desc) {
    if (desc->sec_state.encrypted) {
      isAuthenticated = true; // 放行操作
      if (authFailedCount > 0) {
        authFailedCount = 0;
        preferences.putUInt("failCount", 0);
      }
      APP_LOG("[AUTH] Pairing & Encryption Successful.");
    } else {
      isAuthenticated = false;
      authFailedCount++;
      preferences.putUInt("failCount", authFailedCount);
      APP_LOG("[AUTH] FAILED: PIN mismatch! Current Attempts: %d/5", authFailedCount);
      
      if (authFailedCount >= 5) {
        isLocked = true;
        lockStartTime = millis();
        APP_LOG("[SEC] CRITICAL: BRUTE-FORCE DETECTED! Shutting down BLE broadcast for 3 mins.");
      }
      pServer->disconnect(pServer->getConnId()); // 立即强制踢开
    }
  }
#else
  void onAuthenticationComplete(esp_ble_auth_cmpl_t auth_cmpl) {
    if (auth_cmpl.success) {
      isAuthenticated = true; // 放行操作
      if (authFailedCount > 0) {
        authFailedCount = 0;
        preferences.putUInt("failCount", 0);
      }
      APP_LOG("[AUTH] Pairing & Encryption Successful.");
    } else {
      isAuthenticated = false;
      authFailedCount++;
      preferences.putUInt("failCount", authFailedCount);
      APP_LOG("[AUTH] FAILED: PIN mismatch! Current Attempts: %d/5", authFailedCount);

      if (authFailedCount >= 5) {
        isLocked = true;
        lockStartTime = millis();
        APP_LOG("[SEC] CRITICAL: BRUTE-FORCE DETECTED! Shutting down BLE broadcast for 3 mins.");
      }
      pServer->disconnect(pServer->getConnId()); // 立即强制踢开
    }
  }
#endif
};

// ============================================================
// SETUP 函数 - 低电压优化版
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(100);
  
  Serial.println("\n\n=== ESP32-C3 Car Key BLE (Low Power) ===");
  Serial.printf("Compiled: %s %s\n", __DATE__, __TIME__);

  // 初始化并加载 NVS 存储的密码和错误限制
  preferences.begin("carkey", false);
  devicePasskey = preferences.getUInt("passkey", 123456);
  authFailedCount = preferences.getUInt("failCount", 0);
  APP_LOG("[INIT] Loaded PIN Code: %06d", devicePasskey);
  
  // 防御机制物理记忆接力
  if (authFailedCount > 0) {
    APP_LOG("[SEC] Warning: Previous run had %d failed PIN attempts.", authFailedCount);
    if (authFailedCount >= 5) {
      isLocked = true;
      lockStartTime = millis();
      APP_LOG("[SEC] Continuing NVS Defense Mode. Broadcast suppressed for 3 mins.");
    }
  }

  // 初始化 GPIO
  APP_LOG("[INIT] Initializing GPIO...");
  pinMode(PIN_UNLOCK, OUTPUT);
  pinMode(PIN_LOCK, OUTPUT);
  pinMode(PIN_TRUNK, OUTPUT);
  pinMode(PIN_AUX, OUTPUT);
  digitalWrite(PIN_UNLOCK, LOW);
  digitalWrite(PIN_LOCK, LOW);
  digitalWrite(PIN_TRUNK, LOW);
  digitalWrite(PIN_AUX, LOW);
  APP_LOG("[INIT] GPIO initialized");

  // 初始化 BLE - 低功耗配置
  Serial.println("[INIT] Initializing BLE...");
  
  // 禁用 Bluetooth Classic，只使用 BLE 以节省功耗
  BLEDevice::init(DEVICE_NAME);
  
  // 设置 TX 功率为最低（节省功耗）
  // 范围: -12 dBm 到 +9 dBm
  // -12 dBm 时功耗最低，但距离较短（1-2 米）
  // 0 dBm 时功耗中等，距离适中（3-5 米）
  // +9 dBm 时功耗最高，距离最远（10+ 米）
  BLEDevice::setPower(ESP_PWR_LVL_N0);  // 0 dBm，平衡功耗和距离
  
  // 设置安全参数
  Serial.println("[INIT] Setting security...");
#if defined(CONFIG_BLUEDROID_ENABLED)
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT_MITM);
#endif
  BLEDevice::setSecurityCallbacks(new MySecurityCallbacks());

  // 创建 BLE 服务器
  Serial.println("[INIT] Creating BLE server...");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  // 创建服务
  Serial.println("[INIT] Creating service...");
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // 创建特征值
  Serial.println("[INIT] Creating characteristic...");
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ   |
                      BLECharacteristic::PROPERTY_WRITE  |
                      BLECharacteristic::PROPERTY_NOTIFY |
                      BLECharacteristic::PROPERTY_INDICATE
                    );

  // 设置特征值的安全权限
  pCharacteristic->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED | ESP_GATT_PERM_WRITE_ENCRYPTED);
  pCharacteristic->setCallbacks(new MyCharacteristicCallbacks());
  pCharacteristic->addDescriptor(new BLE2902());

  // 启动服务
  Serial.println("[INIT] Starting service...");
  pService->start();

  // 配置广播 - 低功耗模式
  Serial.println("[INIT] Configuring advertising...");
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMaxPreferred(0x12);
  
  // 设置广播间隔以优化功耗与连接响应速度 (单位: 0.625ms)
  // 如果间隔过大（如原来的2~4秒），手机极易因为扫描窗口错过而产生搜索超时，也无法实现后台自动连接。
  // 苹果/安卓推荐后台快速发现的广播间隔为 200~300ms
  // 320 * 0.625ms = 200ms
  // 480 * 0.625ms = 300ms
  pAdvertising->setMinInterval(320);  // 200ms
  pAdvertising->setMaxInterval(480);  // 300ms

  // 启动广播
  Serial.println("[INIT] Starting advertising...");
  if (!isLocked) {
    BLEDevice::startAdvertising();
  } else {
    APP_LOG("[SEC] Initially suppressing advertising due to NVS Lockout status.");
  }
  
  // 配置安全配全
  Serial.println("[INIT] Setting up security...");
  BLESecurity *pSecurity = new BLESecurity();
  pSecurity->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  pSecurity->setCapability(ESP_IO_CAP_OUT);
  pSecurity->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  
  // 必须显式将咱们加载的动态密码注入给蓝牙底层的静态密码管理中！
  BLESecurity::setPassKey(true, devicePasskey);

  APP_LOG("[SUCCESS] BLE Server is ready!");
  APP_LOG("[SUCCESS] Device Name: %s", DEVICE_NAME);
  APP_LOG("[SUCCESS] Service UUID: %s", SERVICE_UUID);
  APP_LOG("[SUCCESS] Waiting for connections...");

  lastActivityTime = millis();

  // ============================================================
  // 低功耗配置（在 BLE 初始化完成后配置，顺序不可颠倒）
  // ============================================================

  // 1. 启用 BLE Modem Sleep
  //    在 BLE 广播间隙期间，射频模拟电路自动掉电，可将
  //    广播待机电流从 ~8mA 均值降低至 ~0.2mA 均值。
  //    注意：必须在 BLEDevice::startAdvertising() 之后调用。
  esp_bt_sleep_enable();
  APP_LOG("[PM] BLE Modem Sleep enabled.");

  // 2. 配置自动 Light Sleep（CPU 频率动态缩放 + 空闲自动入睡）
  //    当 loop() 中调用 delay() 或 esp_light_sleep_start() 时，
  //    系统将真正进入 Light Sleep，而非仅 CPU IDLE。
  //    Light Sleep 期间 BLE 连接上下文和 RAM 状态完整保留。
  esp_pm_config_t pm_config = {
      .max_freq_mhz       = 160,  // 峰值频率（执行指令/BLE 事务时）
      .min_freq_mhz       = 10,   // 最低频率（Light Sleep 退出过渡态）
      .light_sleep_enable = true  // 空闲时自动进入 Light Sleep
  };
  esp_err_t pm_err = esp_pm_configure(&pm_config);
  if (pm_err == ESP_OK) {
    APP_LOG("[PM] Auto Light Sleep configured. max=%dMHz, min=%dMHz.", 
            pm_config.max_freq_mhz, pm_config.min_freq_mhz);
  } else {
    APP_LOG("[PM] WARNING: esp_pm_configure failed: %s", esp_err_to_name(pm_err));
  }
}

// ============================================================
// LOOP 函数 - 低功耗管理
// ============================================================
void loop() {
  // 安全大闸：检查锁定是否过期，防溢出计时算法
  if (isLocked && (millis() - lockStartTime >= LOCK_TIMEOUT_MS)) {
    isLocked = false;
    authFailedCount = 0;
    preferences.putUInt("failCount", 0);
    APP_LOG("[SEC] Lockout expired! Security logs cleared.");
    if (!deviceConnected) {
      APP_LOG("[SYS] Resuming BLE Advertising...");
      pServer->getAdvertising()->start();
    }
  }

  // 检查连接状态变化：断开 -> 重新广播
  if (!deviceConnected && oldDeviceConnected) {
    // 给蓝牙协议栈 500ms 完成断开清理
    delay(500);
    if (!isLocked) {
      pServer->startAdvertising();
      APP_LOG("[SYS] Advertising active. Waiting for clients...");
    }
    oldDeviceConnected = deviceConnected;
  }

  // 检查连接状态变化：已连接
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  // ============================================================
  // 低功耗主循环
  // ============================================================
  if (!deviceConnected) {
    // 未连接（广播中）：进入 Light Sleep 1 秒
    // 配合 esp_pm_configure 的自动 Light Sleep + BLE Modem Sleep，
    // 实际平均电流可降至 ~150~250μA（取决于广播间隔和 LDO 静态电流）。
    // BLE 广播事件由硬件定时器自动唤醒，不会影响可发现性。
    esp_sleep_enable_timer_wakeup(1000 * 1000ULL); // 1 秒 = 1,000,000 μs
    esp_light_sleep_start();
    // 从 Light Sleep 返回后继续执行（状态完整保留）
  } else {
    // 已连接：保持正常 delay，确保指令响应速度
    // 自动 Light Sleep 仍在 delay 的 IDLE 间隙中发挥作用
    delay(100);
  }
}

// ============================================================
// 故障排查辅助函数
// ============================================================

/*
 * 低电压问题排查清单：
 * 
 * 1. 电压检查
 *    - 用万用表测量 CR2032 电池电压（应 >= 3.0V）
 *    - 测量 ESP32-C3 VCC 引脚电压（应 >= 2.9V）
 *    - 如果电压过低，更换电池或使用更大容量电池
 * 
 * 2. 电源滤波
 *    - 在 VCC 和 GND 之间添加 100μF 电解电容
 *    - 在 VCC 和 GND 之间添加 0.1μF 陶瓷电容
 *    - 这样可以稳定电压，解决 BLE 启动问题
 * 
 * 3. GPIO 冲突
 *    - 本版本使用 GPIO 8, 9, 10, 18 避免与 BLE 冲突
 *    - 原版本使用 GPIO 1, 2, 3, 4 可能与 BLE 冲突
 * 
 * 4. 功耗优化
 *    - 广播间隔已调整为 2-4 秒（低功耗模式）
 *    - TX 功率设置为 0 dBm（平衡功耗和距离）
 *    - 未连接时 delay(1000)，连接时 delay(100)
 * 
 * 5. 串口调试
 *    - 打开 Arduino IDE 的串口监视器（波特率 115200）
 *    - 查看启动日志，确认 BLE 服务是否成功启动
 *    - 如果看到 "[SUCCESS] BLE Server is ready!"，说明启动成功
 */
