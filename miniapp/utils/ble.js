import { BLE_CONFIG, COMMANDS } from './constants.js';

class BLEManager {
  constructor() {
    this.deviceId = null;
    this.serviceId = null;
    this.characteristicId = null;
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
          console.log('获取服务成功', res.services);
          const targetUUID = BLE_CONFIG.SERVICE_UUID.toLowerCase();
          const targetService = res.services.find(s => s.uuid.toLowerCase() === targetUUID);
          
          if (targetService) {
            this.serviceId = targetService.uuid;
            resolve(res.services);
          } else {
            reject(new Error('无法匹配指定的蓝牙服务'));
          }
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
        serviceId: this.serviceId || BLE_CONFIG.SERVICE_UUID,
        success: (res) => {
          console.log('获取特征值成功', res.characteristics);
          const targetUUID = BLE_CONFIG.CHARACTERISTIC_UUID.toLowerCase();
          const targetChar = res.characteristics.find(c => c.uuid.toLowerCase() === targetUUID);
          
          if (targetChar) {
            this.characteristicId = targetChar.uuid;
            resolve(res.characteristics);
          } else {
            reject(new Error('无法匹配指定的特征值'));
          }
        },
        fail: (err) => {
          console.error('获取特征值失败', err);
          reject(err);
        }
      });
    });
  }

  /**
   * 触发底层蓝牙安全配对（必须在执行 write 之前完成，否则会被 ESP32 的安全防线判定为非法连接并踢掉导致 10006 断连）
   */
  async authenticate(pin) {
    return new Promise((resolve, reject) => {
      const sysInfo = wx.getSystemInfoSync();
      
      if (sysInfo.platform === 'android' && wx.makeBluetoothPair) {
        console.log('Android 端：尝试静默注入 PIN 码配对...');
        wx.makeBluetoothPair({
          deviceId: this.deviceId,
          pin: String(pin),
          success: (res) => {
            console.log('Android 配对指令下发成功', res);
            // 给安卓底层几十到几百毫秒的真实完成配对的时间，然后再校验
            setTimeout(() => {
              this.forceHardwarePairing().then(resolve).catch(reject);
            }, 800);
          },
          fail: (err) => {
            console.warn('Android 配对指令失败，回退到读策略唤起', err);
            this.forceHardwarePairing().then(resolve).catch(reject);
          }
        });
      } else {
        // iOS 端或老安卓：通过读取带加密属性的特征值，强制迫使 iOS 系统弹起原生的 Bluetooth 配对请求
        console.log('iOS 端：尝试通过读取底层加密特征值触发系统级配对 UI');
        this.forceHardwarePairing().then(resolve).catch(reject);
      }
    });
  }

  /**
   * 强制通过一次底层只读操作来唤起系统的蓝牙配对握手过程
   */
  async forceHardwarePairing() {
    return new Promise((resolve, reject) => {
      wx.readBLECharacteristicValue({
        deviceId: this.deviceId,
        serviceId: this.serviceId || BLE_CONFIG.SERVICE_UUID,
        characteristicId: this.characteristicId || BLE_CONFIG.CHARACTERISTIC_UUID,
        success: (res) => {
          console.log('系统硬件配对握手/读数完毕，正在为固件底层状态分配同步时间', res);
          // 极度关键修复：必须硬延时，ESP32 蓝牙底层 L2CAP 完成加密与业务层 onAuthenticationComplete 触发存在几十~数百毫秒的异步抢占差，
          // 太快发送写命令会被硬件层当成越权操作直接踢下界（触发 10006 断联报错）。
          setTimeout(() => {
            resolve(res);
          }, 600);
        },
        fail: (err) => {
          console.error('系统硬件配对握手失败', err);
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
        serviceId: this.serviceId || BLE_CONFIG.SERVICE_UUID,
        characteristicId: this.characteristicId || BLE_CONFIG.CHARACTERISTIC_UUID,
        value: buffer,
        writeType: 'write',
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
