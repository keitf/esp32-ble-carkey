import { useState, useCallback, useRef } from "react";

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

export interface BLEDevice {
  name: string;
  id: string;
  rssi: number;
}

export function useBLE() {
  const [scanning, setScanning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<BluetoothDevice | null>(null);
  const [signalStrength, setSignalStrength] = useState(0);
  const characteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);

  // 扫描设备
  const scanDevices = useCallback(async (): Promise<BLEDevice[]> => {
    if (!navigator.bluetooth) {
      throw new Error("浏览器不支持 Web Bluetooth API");
    }

    setScanning(true);
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: "CarKey_BLE" }],
        optionalServices: [SERVICE_UUID]
      });

      return [{
        name: device.name || "Unknown",
        id: device.id,
        rssi: -50 // Web BLE API 不直接提供 RSSI，这里使用模拟值
      }];
    } finally {
      setScanning(false);
    }
  }, []);

  // 连接设备
  const connectDevice = useCallback(async (device: BLEDevice, pin: string): Promise<boolean> => {
    if (!navigator.bluetooth) {
      throw new Error("浏览器不支持 Web Bluetooth API");
    }

    try {
      // 请求设备连接
      const bluetoothDevice = await navigator.bluetooth.requestDevice({
        filters: [{ name: device.name }],
        optionalServices: [SERVICE_UUID]
      });

      // 连接到 GATT 服务器
      const server = await bluetoothDevice.gatt!.connect();
      
      // 获取服务
      const service = await server.getPrimaryService(SERVICE_UUID);
      
      // 获取特征值
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      
      characteristicRef.current = characteristic;
      setSelectedDevice(bluetoothDevice);
      setConnected(true);

      // 发送 PIN 码进行认证（这里仅作示例）
      // 实际的认证应该通过 BLE 安全连接进行
      const encoder = new TextEncoder();
      const pinData = encoder.encode(`PIN:${pin}`);
      await characteristic.writeValue(pinData);

      // 启用通知以接收响应
      if (characteristic.properties.notify) {
        await characteristic.startNotifications();
        characteristic.addEventListener("characteristicvaluechanged", (event) => {
          const value = (event.target as unknown as BluetoothRemoteGATTCharacteristic).value;
          if (value) {
            const decoder = new TextDecoder();
            console.log("Received:", decoder.decode(value));
          }
        });
      }

      return true;
    } catch (error) {
      setConnected(false);
      setSelectedDevice(null);
      throw error;
    }
  }, []);

  // 执行命令
  const executeCommand = useCallback(async (command: string): Promise<void> => {
    if (!characteristicRef.current || !connected) {
      throw new Error("设备未连接");
    }

    try {
      const encoder = new TextEncoder();
      const commandData = encoder.encode(command);
      await characteristicRef.current.writeValue(commandData);
    } catch (error) {
      throw new Error("发送命令失败：" + (error as Error).message);
    }
  }, [connected]);

  // 断开连接
  const disconnect = useCallback(async (): Promise<void> => {
    if (selectedDevice && selectedDevice.gatt) {
      try {
        if (characteristicRef.current?.properties.notify) {
          await characteristicRef.current.stopNotifications();
        }
        selectedDevice.gatt.disconnect();
      } catch (error) {
        console.error("断开连接失败：", error);
      }
    }

    characteristicRef.current = null;
    setSelectedDevice(null);
    setConnected(false);
    setSignalStrength(0);
  }, [selectedDevice]);

  // 获取信号强度（模拟）
  const updateSignalStrength = useCallback(() => {
    if (connected) {
      setSignalStrength(Math.floor(Math.random() * 100));
    }
  }, [connected]);

  return {
    scanning,
    connected,
    selectedDevice,
    signalStrength,
    scanDevices,
    connectDevice,
    executeCommand,
    disconnect,
    updateSignalStrength
  };
}
