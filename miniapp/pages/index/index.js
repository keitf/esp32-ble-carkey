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
    signalStrength: 0,
    isConnecting: false,
    isSendingCommand: false
  },

  onLoad() {
    this.intentionalDisconnect = false; // 标记是否为用户主动断开
    this.initBluetooth();
  },

  onShow() {
    // 每次小程序切回前台时，如果之前意外断开，立刻趁机静默重连一把
    if (!this.data.connected && !this.data.isConnecting && !this.intentionalDisconnect) {
      this.autoConnectIfCached(true); // true 代表完全静默，不弹 Loading
    }
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
      
      // 监听底层意外断线（比如人离开车太远），实现断线后静默轮询重连
      wx.onBLEConnectionStateChange((res) => {
        if (!res.connected && this.data.connected) {
          console.warn('设备意外掉线');
          this.setData({ connected: false });
          // 只要不是用户点了断开按钮，就说明是被迫离线，开启后台探针轮询
          if (!this.intentionalDisconnect) {
            this.startReconnectLoop();
          }
        }
      });
      
      // 在蓝牙适配器起来后，尝试使用老缓存无感自动重连
      this.autoConnectIfCached(false);
    } catch (err) {
      wx.showToast({
        title: '蓝牙初始化失败',
        icon: 'error',
        duration: 2000
      });
    }
  },

  /**
   * 自动重连缓存的设备
   */
  async autoConnectIfCached(silent = false) {
    const cachedDevice = wx.getStorageSync('cached_device');
    const cachedPin = wx.getStorageSync('cached_pin');

    if (cachedDevice && cachedPin) {
      this.setData({
        selectedDevice: cachedDevice,
        pin: cachedPin
      });
      
      if (this.data.isConnecting) return;
      this.setData({ isConnecting: true });

      try {
        if (!silent) wx.showLoading({ title: '正在寻卡直连...' });
        
        await bleManager.connectDevice(cachedDevice.deviceId);
        await bleManager.getServices();
        await bleManager.getCharacteristics();
        await bleManager.authenticate(cachedPin);

        this.setData({
          connected: true,
          showPinDialog: false,
          pinError: ''
        });

        if (!silent) {
          wx.hideLoading();
          wx.showToast({ title: '已自动重连', icon: 'success' });
        }
        
        this.stopReconnectLoop(); // 如果是在轮询中成功上岸，则取消重连定时器
        this.updateSignalStrength();
      } catch (err) {
        if (!silent) wx.hideLoading();
        console.warn('无感重连终止（可能设备不在周围或iOS ID已刷新）', err);
        
        const isDistanceError = err.errCode === 10002 || err.errCode === 10003;
        if (isDistanceError) {
          // 在静默探针模式下，如果一直报 10002（找不到指定设备ID），
          // 极有可能是 iOS 系统轮换了设备的物理 MAC 导致缓存 ID 失效。
          // 我们发起一次静默全局扫描来把新 ID 揪出来覆盖。
          if (silent) {
            this.silentScanAndUpdateDevice();
          }
        }
      } finally {
        this.setData({ isConnecting: false });
      }
    }
  },

  startReconnectLoop() {
    if (this._reconnectTimer) return;
    console.log('启动后台静默重连轮询探针...');
    this._reconnectTimer = setInterval(() => {
      // 如果未连接、未在连接中、且并非主观点击断开，就踩一脚油门连一下
      if (!this.data.connected && !this.data.isConnecting && !this.intentionalDisconnect) {
        this.autoConnectIfCached(true);
      } else if (this.data.connected || this.intentionalDisconnect) {
        this.stopReconnectLoop();
      }
    }, 5000); // 暂定每 5 秒自动探测一次周围
  },

  stopReconnectLoop() {
    if (this._reconnectTimer) {
      clearInterval(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  },

  async silentScanAndUpdateDevice() {
    if (this._isSilentScanning) return;
    this._isSilentScanning = true;
    try {
      // 不声张地扫一次，看是不是 iOS 把老设备的暴露 ID 刷新了
      const device = await bleManager.scanDevices();
      wx.setStorageSync('cached_device', device); // 更新最新漂移 ID，下个5秒轮询就能直连了
    } catch (e) {
      // 扫不到就随他去，说明人确实走远了
    } finally {
      this._isSilentScanning = false;
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
      const errMsg = err.errMsg || err.message || '扫描失败';
      wx.showToast({
        title: errMsg,
        icon: 'error'
      });
    }
  },

  /**
   * 连接设备 (用户在扫描列表点击)
   */
  async connectDevice(e) {
    const deviceId = e.currentTarget.dataset.deviceId;
    const device = this.data.devices.find(d => d.deviceId === deviceId);

    this.setData({
      selectedDevice: device
    });

    const cachedPin = wx.getStorageSync('cached_pin');
    if (cachedPin) {
      // iOS / 重新发现缓存设备防 ID 更换：携带老 PIN 码自动起飞
      this.setData({ pin: cachedPin });
      this.verifyAndConnect();
    } else {
      this.setData({ showPinDialog: true });
    }
  },

  /**
   * 验证 PIN 并连接
   */
  async verifyAndConnect() {
    if (this.data.isConnecting) return;

    const { pin } = this.data;

    if (!pin || pin.length !== 6) {
      this.setData({ pinError: 'PIN 码必须是 6 位数字' });
      return;
    }

    if (!/^\d{6}$/.test(pin)) {
      this.setData({ pinError: 'PIN 码只能包含数字' });
      return;
    }

    this.intentionalDisconnect = false;
    this.setData({ isConnecting: true });

    try {
      wx.showLoading({ title: '正在连接...' });

      const device = this.data.selectedDevice;
      await bleManager.connectDevice(device.deviceId);

      // 获取服务和特征值
      await bleManager.getServices();
      await bleManager.getCharacteristics();
      
      // 执行底层硬件级带 PIN 码的安全认证和配对（由于固件启用了 MITM 且拦截未授权读写）
      await bleManager.authenticate(pin);

      // 连接配对完全完毕，存储持久化信息供下次启动加速
      wx.setStorageSync('cached_device', this.data.selectedDevice);
      wx.setStorageSync('cached_pin', pin);

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
      
      const isDistanceError = err.errCode === 10002 || err.errCode === 10003;
      if (isDistanceError) {
        this.setData({ pinError: '设备不在附近或者未开机' });
        if (!this.data.showPinDialog && !wx.getStorageSync('cached_pin')) {
           this.setData({ showPinDialog: true });
        }
      } else {
        // 如果不是距离原因（比如密码错误，验证失败强踢 10006），则注销本地档案要求重配
        wx.removeStorageSync('cached_device');
        wx.removeStorageSync('cached_pin');
        this.setData({ 
          pinError: '身份认证失效，请重新输入', 
          pin: '', // 清空死数据
          showPinDialog: true // 如果因为各种失败，立刻恢复密码弹窗要求人工重试
        });
      }
      
      const errMsg = err.errMsg || err.message || '未知错误';
      wx.showToast({
        title: '连接失败',
        icon: 'error'
      });
    } finally {
      this.setData({ isConnecting: false });
    }
  },

  /**
   * 执行命令
   */
  async executeCommand(e) {
    if (this.data.isSendingCommand) return;
    
    const command = e.currentTarget.dataset.command;

    if (!this.data.connected) {
      wx.showToast({
        title: '设备未连接',
        icon: 'error'
      });
      return;
    }

    this.setData({ isSendingCommand: true });

    try {
      wx.showLoading({ title: '执行中...' });
      
      // 增加 10 秒超时防护
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('系统执行指令超时（10秒无响）')), 10000);
      });
      
      await Promise.race([
        bleManager.sendCommand(command),
        timeoutPromise
      ]);

      wx.hideLoading();
      wx.showToast({
        title: COMMAND_LABELS[command] + '成功',
        icon: 'success'
      });
    } catch (err) {
      wx.hideLoading();
      const errMsg = err.errMsg || err.message || '未知错误';
      wx.showToast({
        title: '执行失败: ' + errMsg,
        icon: 'error'
      });
    } finally {
      this.setData({ isSendingCommand: false });
    }
  },

  /**
   * 断开连接
   */
  async disconnect() {
    try {
      this.intentionalDisconnect = true; // 登记为主观点击断开，阻止底层防丢轮询机制发起救援
      this.stopReconnectLoop();
      await bleManager.disconnect();
      this.setData({ connected: false });
      wx.showToast({
        title: '已断开连接',
        icon: 'success'
      });
    } catch (err) {
      const errMsg = err.errMsg || err.message || '未知错误';
      wx.showToast({
        title: '断开失败: ' + errMsg,
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
      
      if (this.data.selectedDevice && this.data.selectedDevice.deviceId) {
        wx.getBLEDeviceRSSI({
          deviceId: this.data.selectedDevice.deviceId,
          success: (res) => {
            // 将 RSSI（常见的 -30dBm 到 -100dBm 之间）转换为体感百分比 0-100%
            let strength = Math.max(0, Math.min(100, 100 + (res.RSSI + 30) * (100 / 60)));
            strength = Math.floor(strength);
            
            let color = '#22c55e'; // 绿色 (信号好)
            if (strength < 30) color = '#ef4444'; // 红色 (信号弱)
            else if (strength < 70) color = '#f59e0b'; // 橘色 (中等)
            
            this.setData({
              signalStrength: strength,
              signalColor: color
            });
          },
          fail: () => {
            // 如果读取失败偶尔发生可忽略，直接展示原始数据即可
          }
        });
      }
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
