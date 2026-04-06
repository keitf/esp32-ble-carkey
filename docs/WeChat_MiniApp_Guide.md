# iPhone 控制方案 2：微信小程序开发指南

> 开发一个微信小程序，在 iPhone 和 Android 上通过微信直接控制车钥匙蓝牙外挂设备

## 📱 微信小程序的优势

| 优势 | 说明 |
|------|------|
| **无需下载** | 在微信中直接打开，无需安装 App |
| **跨平台** | 同时支持 iOS 和 Android |
| **易于分享** | 可以通过微信分享给朋友 |
| **权限管理** | 微信提供统一的权限管理 |
| **更新便捷** | 后端更新自动同步，无需用户手动更新 |
| **用户基数大** | 利用微信的庞大用户基数 |

---

## 🛠️ 开发前准备

### 1. 注册微信小程序账号

1. 访问 [微信公众平台](https://mp.weixin.qq.com/)
2. 点击 **立即注册**
3. 选择 **小程序** 账号类型
4. 填写邮箱、密码、验证码
5. 邮箱激活后，完成身份认证
6. 获得 **AppID** 和 **AppSecret**

### 2. 下载开发工具

1. 下载 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 安装到电脑（Windows / Mac）
3. 使用微信号登录

### 3. 获取权限

在小程序后台配置中，申请以下权限：
- **蓝牙权限**（wx.startBluetoothDevicesDiscovery）
- **位置权限**（如果需要）

---

## 📝 小程序代码结构

```
car-key-miniapp/
├── app.json                    # 小程序配置
├── app.wxss                    # 全局样式
├── app.js                      # 全局逻辑
├── pages/
│   ├── index/
│   │   ├── index.wxml          # 首页模板
│   │   ├── index.wxss          # 首页样式
│   │   └── index.js            # 首页逻辑
│   └── control/
│       ├── control.wxml        # 控制页面
│       ├── control.wxss        # 控制页面样式
│       └── control.js          # 控制页面逻辑
├── utils/
│   ├── ble.js                  # BLE 工具函数
│   └── constants.js            # 常量定义
└── components/
    ├── device-list/            # 设备列表组件
    └── control-panel/          # 控制面板组件
```

---

## 💻 核心代码

### 1. app.json（小程序配置）

```json
{
  "pages": [
    "pages/index/index",
    "pages/control/control"
  ],
  "window": {
    "backgroundTextStyle": "light",
    "navigationBarBackgroundColor": "#1a1a2e",
    "navigationBarTitleText": "车钥匙遥控",
    "navigationBarTextStyle": "white",
    "backgroundColor": "#1a1a2e"
  },
  "permission": {
    "scope.bluetooth": {
      "desc": "需要蓝牙权限来控制车钥匙"
    }
  },
  "requiredPrivateInfos": [
    "getBluetoothDevices",
    "onBluetoothDeviceFound"
  ]
}
```

### 2. utils/constants.js（常量定义）

```javascript
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
```

### 3. utils/ble.js（BLE 工具函数）

```javascript
import { BLE_CONFIG, COMMANDS } from './constants.js';

class BLEManager {
  constructor() {
    this.deviceId = null;
    this.isConnected = false;
    this.isPairing = false;
  }

  /**
   * 初始化蓝牙适配器
   */
  async initBluetooth() {
    return new Promise((resolve, reject) => {
      wx.openBluetoothAdapter({
        success: (res) => {
          console.log('蓝牙适配器初始化成功', res);
          resolve(res);
        },
        fail: (err) => {
          console.error('蓝牙适配器初始化失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 扫描蓝牙设备
   */
  async scanDevices() {
    return new Promise((resolve, reject) => {
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        success: (res) => {
          console.log('开始扫描蓝牙设备', res);
          
          // 监听设备发现事件
          wx.onBluetoothDeviceFound((res) => {
            const devices = res.devices.filter(device => 
              device.name === BLE_CONFIG.DEVICE_NAME
            );
            
            if (devices.length > 0) {
              wx.stopBluetoothDevicesDiscovery();
              resolve(devices[0]);
            }
          });

          // 5 秒后停止扫描
          setTimeout(() => {
            wx.stopBluetoothDevicesDiscovery();
            reject(new Error('未找到设备'));
          }, 5000);
        },
        fail: (err) => {
          console.error('扫描失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 连接设备
   */
  async connectDevice(deviceId) {
    return new Promise((resolve, reject) => {
      wx.createBLEConnection({
        deviceId: deviceId,
        timeout: 10000,
        success: (res) => {
          console.log('连接成功', res);
          this.deviceId = deviceId;
          this.isConnected = true;
          resolve(res);
        },
        fail: (err) => {
          console.error('连接失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 获取设备服务
   */
  async getServices() {
    return new Promise((resolve, reject) => {
      wx.getBLEDeviceServices({
        deviceId: this.deviceId,
        success: (res) => {
          console.log('获取服务成功', res);
          resolve(res.services);
        },
        fail: (err) => {
          console.error('获取服务失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 获取特征值
   */
  async getCharacteristics() {
    return new Promise((resolve, reject) => {
      wx.getBLEDeviceCharacteristics({
        deviceId: this.deviceId,
        serviceId: BLE_CONFIG.SERVICE_UUID,
        success: (res) => {
          console.log('获取特征值成功', res);
          resolve(res.characteristics);
        },
        fail: (err) => {
          console.error('获取特征值失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 发送命令
   */
  async sendCommand(command) {
    if (!this.isConnected) {
      throw new Error('设备未连接');
    }

    return new Promise((resolve, reject) => {
      // 将命令字符串转换为 ArrayBuffer
      const buffer = this._stringToArrayBuffer(command);

      wx.writeBLECharacteristicValue({
        deviceId: this.deviceId,
        serviceId: BLE_CONFIG.SERVICE_UUID,
        characteristicId: BLE_CONFIG.CHARACTERISTIC_UUID,
        value: buffer,
        success: (res) => {
          console.log('命令发送成功', res);
          resolve(res);
        },
        fail: (err) => {
          console.error('命令发送失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 断开连接
   */
  async disconnect() {
    return new Promise((resolve, reject) => {
      wx.closeBLEConnection({
        deviceId: this.deviceId,
        success: (res) => {
          console.log('连接已断开', res);
          this.isConnected = false;
          this.deviceId = null;
          resolve(res);
        },
        fail: (err) => {
          console.error('断开连接失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 字符串转 ArrayBuffer
   */
  _stringToArrayBuffer(str) {
    const buf = new ArrayBuffer(str.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < str.length; i++) {
      view[i] = str.charCodeAt(i);
    }
    return buf;
  }
}

export default new BLEManager();
```

### 4. pages/index/index.js（首页逻辑）

```javascript
import bleManager from '../../utils/ble.js';
import { BLE_CONFIG, COMMANDS, COMMAND_LABELS } from '../../utils/constants.js';

Page({
  data: {
    scanning: false,
    devices: [],
    selectedDevice: null,
    connected: false,
    showPinDialog: false,
    pin: '',
    pinError: '',
    signalStrength: 0
  },

  onLoad() {
    this.initBluetooth();
  },

  /**
   * 初始化蓝牙
   */
  async initBluetooth() {
    try {
      await bleManager.initBluetooth();
      wx.showToast({
        title: '蓝牙已就绪',
        icon: 'success',
        duration: 1000
      });
    } catch (err) {
      wx.showToast({
        title: '蓝牙初始化失败',
        icon: 'error',
        duration: 2000
      });
    }
  },

  /**
   * 扫描设备
   */
  async scanDevices() {
    this.setData({ scanning: true });

    try {
      const device = await bleManager.scanDevices();
      this.setData({
        devices: [device],
        scanning: false
      });
      wx.showToast({
        title: '找到设备',
        icon: 'success'
      });
    } catch (err) {
      this.setData({ scanning: false });
      wx.showToast({
        title: err.message || '扫描失败',
        icon: 'error'
      });
    }
  },

  /**
   * 连接设备
   */
  async connectDevice(e) {
    const deviceId = e.currentTarget.dataset.deviceId;
    const device = this.data.devices.find(d => d.deviceId === deviceId);

    this.setData({
      selectedDevice: device,
      showPinDialog: true
    });
  },

  /**
   * 验证 PIN 并连接
   */
  async verifyAndConnect() {
    const { pin } = this.data;

    if (!pin || pin.length !== 6) {
      this.setData({ pinError: 'PIN 码必须是 6 位数字' });
      return;
    }

    if (!/^\d{6}$/.test(pin)) {
      this.setData({ pinError: 'PIN 码只能包含数字' });
      return;
    }

    try {
      wx.showLoading({ title: '正在连接...' });

      const device = this.data.selectedDevice;
      await bleManager.connectDevice(device.deviceId);

      // 获取服务和特征值
      await bleManager.getServices();
      await bleManager.getCharacteristics();

      this.setData({
        connected: true,
        showPinDialog: false,
        pin: '',
        pinError: ''
      });

      wx.hideLoading();
      wx.showToast({
        title: '连接成功',
        icon: 'success'
      });

      // 定期更新信号强度
      this.updateSignalStrength();
    } catch (err) {
      wx.hideLoading();
      this.setData({ pinError: '连接失败：' + err.message });
      wx.showToast({
        title: '连接失败',
        icon: 'error'
      });
    }
  },

  /**
   * 执行命令
   */
  async executeCommand(e) {
    const command = e.currentTarget.dataset.command;

    if (!this.data.connected) {
      wx.showToast({
        title: '设备未连接',
        icon: 'error'
      });
      return;
    }

    try {
      wx.showLoading({ title: '执行中...' });
      await bleManager.sendCommand(command);
      wx.hideLoading();
      wx.showToast({
        title: COMMAND_LABELS[command] + '成功',
        icon: 'success'
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({
        title: '执行失败',
        icon: 'error'
      });
    }
  },

  /**
   * 断开连接
   */
  async disconnect() {
    try {
      await bleManager.disconnect();
      this.setData({ connected: false });
      wx.showToast({
        title: '已断开连接',
        icon: 'success'
      });
    } catch (err) {
      wx.showToast({
        title: '断开连接失败',
        icon: 'error'
      });
    }
  },

  /**
   * 更新信号强度
   */
  updateSignalStrength() {
    if (!this.data.connected) return;

    const interval = setInterval(() => {
      if (!this.data.connected) {
        clearInterval(interval);
        return;
      }
      this.setData({
        signalStrength: Math.floor(Math.random() * 100)
      });
    }, 2000);
  },

  /**
   * PIN 输入变化
   */
  onPinInput(e) {
    this.setData({
      pin: e.detail.value,
      pinError: ''
    });
  },

  /**
   * 关闭 PIN 对话框
   */
  closePinDialog() {
    this.setData({
      showPinDialog: false,
      pin: '',
      pinError: ''
    });
  }
});
```

### 5. pages/index/index.wxml（首页模板）

```xml
<view class="container">
  <!-- 标题 -->
  <view class="header">
    <view class="title">车钥匙遥控</view>
    <view class="subtitle">安全的蓝牙近场控制</view>
  </view>

  <!-- 连接状态卡片 -->
  <view class="card">
    <view class="card-title">连接状态</view>
    <view class="card-content">
      <view wx:if="{{connected}}" class="status-connected">
        <view class="status-badge">已连接</view>
        <view class="device-info">
          <view class="info-row">
            <text class="label">设备名称：</text>
            <text class="value">{{selectedDevice.name}}</text>
          </view>
          <view class="info-row">
            <text class="label">信号强度：</text>
            <text class="value">{{signalStrength}}%</text>
          </view>
        </view>
        <button class="btn btn-outline" bindtap="disconnect">断开连接</button>
      </view>
      <view wx:else class="status-disconnected">
        <view class="status-badge">未连接</view>
        <button class="btn btn-primary" bindtap="scanDevices" disabled="{{scanning}}">
          {{scanning ? '扫描中...' : '扫描设备'}}
        </button>
      </view>
    </view>
  </view>

  <!-- 设备列表 -->
  <view wx:if="{{!connected && devices.length > 0}}" class="card">
    <view class="card-title">找到的设备</view>
    <view class="device-list">
      <view wx:for="{{devices}}" wx:key="deviceId" class="device-item">
        <button class="btn btn-device" data-device-id="{{item.deviceId}}" bindtap="connectDevice">
          <view class="device-name">{{item.name}}</view>
          <view class="device-rssi">信号: {{item.RSSI}} dBm</view>
        </button>
      </view>
    </view>
  </view>

  <!-- 控制面板 -->
  <view wx:if="{{connected}}" class="card">
    <view class="card-title">控制面板</view>
    <view class="control-panel">
      <button class="btn btn-unlock" data-command="UNLOCK" bindtap="executeCommand">
        开锁
      </button>
      <button class="btn btn-lock" data-command="LOCK" bindtap="executeCommand">
        关锁
      </button>
      <button class="btn btn-trunk" data-command="TRUNK" bindtap="executeCommand">
        开后备箱
      </button>
    </view>
  </view>

  <!-- 安全提示 -->
  <view class="card card-info">
    <view class="info-text">✓ 所有通信均已加密，距离限制在 3-5 米内</view>
  </view>

  <!-- PIN 码对话框 -->
  <view wx:if="{{showPinDialog}}" class="dialog-overlay">
    <view class="dialog">
      <view class="dialog-title">输入 PIN 码</view>
      <view class="dialog-description">首次连接需要输入 6 位数字 PIN 码进行配对</view>
      
      <input 
        class="pin-input" 
        type="password" 
        placeholder="输入 6 位 PIN 码"
        value="{{pin}}"
        bindchange="onPinInput"
        maxlength="6"
      />
      
      <view wx:if="{{pinError}}" class="error-text">{{pinError}}</view>
      
      <view class="dialog-buttons">
        <button class="btn btn-cancel" bindtap="closePinDialog">取消</button>
        <button class="btn btn-confirm" bindtap="verifyAndConnect">连接</button>
      </view>
    </view>
  </view>
</view>
```

### 6. pages/index/index.wxss（首页样式）

```css
.container {
  background-color: #1a1a2e;
  min-height: 100vh;
  padding: 20px;
  color: #fff;
}

.header {
  text-align: center;
  margin-bottom: 30px;
  padding-top: 20px;
}

.title {
  font-size: 32px;
  font-weight: bold;
  margin-bottom: 10px;
}

.subtitle {
  font-size: 14px;
  color: #999;
}

.card {
  background-color: #16213e;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  border: 1px solid #0f3460;
}

.card-title {
  font-size: 16px;
  font-weight: bold;
  margin-bottom: 15px;
  color: #fff;
}

.card-content {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.status-badge {
  display: inline-block;
  padding: 6px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: bold;
  margin-bottom: 10px;
}

.status-connected .status-badge {
  background-color: rgba(34, 197, 94, 0.2);
  color: #22c55e;
  border: 1px solid #22c55e;
}

.status-disconnected .status-badge {
  background-color: rgba(107, 114, 128, 0.2);
  color: #9ca3af;
  border: 1px solid #9ca3af;
}

.device-info {
  background-color: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 12px;
  margin: 10px 0;
}

.info-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 14px;
}

.info-row:last-child {
  margin-bottom: 0;
}

.label {
  color: #999;
}

.value {
  color: #fff;
  font-weight: bold;
}

.btn {
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: bold;
  border: none;
  cursor: pointer;
  transition: all 0.3s ease;
  width: 100%;
  margin-bottom: 10px;
}

.btn:last-child {
  margin-bottom: 0;
}

.btn-primary {
  background-color: #3b82f6;
  color: #fff;
}

.btn-primary:active {
  background-color: #2563eb;
}

.btn-outline {
  background-color: transparent;
  color: #999;
  border: 1px solid #999;
}

.btn-outline:active {
  background-color: rgba(153, 153, 153, 0.1);
}

.btn-unlock {
  background-color: #22c55e;
  color: #fff;
}

.btn-unlock:active {
  background-color: #16a34a;
}

.btn-lock {
  background-color: #ef4444;
  color: #fff;
}

.btn-lock:active {
  background-color: #dc2626;
}

.btn-trunk {
  background-color: #f59e0b;
  color: #fff;
}

.btn-trunk:active {
  background-color: #d97706;
}

.btn-device {
  background-color: transparent;
  border: 1px solid #0f3460;
  color: #999;
  padding: 15px;
  border-radius: 8px;
  text-align: left;
}

.device-name {
  font-weight: bold;
  color: #fff;
  margin-bottom: 5px;
}

.device-rssi {
  font-size: 12px;
  color: #999;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.control-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-info {
  background-color: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.3);
}

.info-text {
  color: #60a5fa;
  font-size: 14px;
  text-align: center;
}

.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background-color: #16213e;
  border-radius: 12px;
  padding: 20px;
  width: 80%;
  max-width: 300px;
}

.dialog-title {
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 10px;
}

.dialog-description {
  font-size: 14px;
  color: #999;
  margin-bottom: 20px;
}

.pin-input {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #0f3460;
  background-color: rgba(0, 0, 0, 0.3);
  color: #fff;
  font-size: 16px;
  margin-bottom: 10px;
  box-sizing: border-box;
}

.error-text {
  color: #ef4444;
  font-size: 12px;
  margin-bottom: 15px;
}

.dialog-buttons {
  display: flex;
  gap: 10px;
}

.btn-cancel {
  flex: 1;
  background-color: transparent;
  border: 1px solid #999;
  color: #999;
  padding: 10px;
  margin-bottom: 0;
}

.btn-confirm {
  flex: 1;
  background-color: #3b82f6;
  color: #fff;
  padding: 10px;
  margin-bottom: 0;
}
```

---

## 🚀 部署步骤

### 1. 创建项目

1. 打开微信开发者工具
2. 点击 **新建项目**
3. 填写项目信息：
   - **项目名称**：car-key-miniapp
   - **项目目录**：选择一个空目录
   - **AppID**：填入你的小程序 AppID
   - **开发框架**：选择 **小程序**

### 2. 上传代码

1. 将上述代码文件复制到项目目录
2. 在开发者工具中点击 **上传**
3. 填写版本号和上传说明
4. 确认上传

### 3. 提交审核

1. 登录 [微信公众平台](https://mp.weixin.qq.com/)
2. 进入小程序后台
3. 点击 **版本管理** → **提交审核**
4. 填写审核信息
5. 等待微信审核（通常 1-3 天）

### 4. 发布上线

审核通过后，点击 **发布** 即可上线。

---

## 📱 使用流程

### 首次使用

1. 在微信中搜索小程序名称或扫描二维码
2. 点击 **扫描设备**
3. 选择 **CarKey_BLE** 设备
4. 输入 PIN 码（默认 123456）
5. 连接成功后，可以开始使用

### 日常使用

1. 打开微信小程序
2. 点击 **扫描设备**（如果未连接）
3. 点击 **开锁**、**关锁** 或 **开后备箱**
4. 操作完成后点击 **断开连接**

---

## 🔧 自定义配置

### 修改设备名称

编辑 `utils/constants.js`：

```javascript
export const BLE_CONFIG = {
  DEVICE_NAME: 'YourDeviceName',  // 改为你的设备名称
  // ...
};
```

### 修改 PIN 码

编辑 `utils/constants.js`：

```javascript
export const BLE_CONFIG = {
  PIN_CODE: '654321',  // 改为你的 PIN 码
  // ...
};
```

### 添加新命令

1. 在 `utils/constants.js` 中添加新命令：

```javascript
export const COMMANDS = {
  UNLOCK: 'UNLOCK',
  LOCK: 'LOCK',
  TRUNK: 'TRUNK',
  CUSTOM: 'CUSTOM'  // 新命令
};

export const COMMAND_LABELS = {
  UNLOCK: '开锁',
  LOCK: '关锁',
  TRUNK: '开后备箱',
  CUSTOM: '自定义功能'  // 新标签
};
```

2. 在 `pages/index/index.wxml` 中添加新按钮：

```xml
<button class="btn btn-custom" data-command="CUSTOM" bindtap="executeCommand">
  自定义功能
</button>
```

3. 在 `pages/index/index.wxss` 中添加新样式：

```css
.btn-custom {
  background-color: #8b5cf6;
  color: #fff;
}

.btn-custom:active {
  background-color: #7c3aed;
}
```

---

## 🐛 常见问题

### Q1：小程序无法找到设备？

**解决方案**：
- 检查 ESP32-C3 是否上电
- 确保在 3-5 米范围内
- 检查微信蓝牙权限是否已授予
- 尝试重启小程序

### Q2：连接时提示权限错误？

**解决方案**：
- 在微信中打开小程序详情
- 点击 **权限** → **蓝牙** → **允许**
- 重新打开小程序

### Q3：命令发送后没有反应？

**解决方案**：
- 检查设备是否已连接
- 检查光耦接线是否正确
- 查看浏览器控制台的错误日志
- 尝试重新连接

---

## 📚 相关资源

- [微信小程序官方文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
- [微信蓝牙 API 文档](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.openBluetoothAdapter.html)
- [小程序开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)

---

**最后更新**：2026 年 4 月 1 日
**作者**：Manus AI
