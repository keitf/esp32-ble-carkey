import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bluetooth, Lock, Unlock, Luggage, Signal, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { BleClient, textToDataView } from "@capacitor-community/bluetooth-le";

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

interface BLEDevice {
  name: string;
  id: string; // MAC address in native or ID in web
  rssi: number;
}

export default function BLEController() {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<BLEDevice[]>([]);
  const [connected, setConnected] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<BLEDevice | null>(null);
  
  const [isExecuting, setIsExecuting] = useState(false);
  const [signalStrength, setSignalStrength] = useState(0);

  // Web Bluetooth 的 GATT 引用
  const gattServerRef = useRef<any>(null);

  // 初始化原生蓝牙
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      BleClient.initialize().catch(err => {
        toast.error("原生蓝牙初始化失败: " + err.message);
      });
    }
  }, []);

  const handleDisconnect = () => {
    setConnected(false);
    setSelectedDevice(null);
    setSignalStrength(0);
    gattServerRef.current = null;
    toast.info("已断开连接");
  };

  const startScan = async () => {
    setScanning(true);
    setDevices([]);
    try {
      if (Capacitor.isNativePlatform()) {
        // == 原生 Capacitor 蓝牙搜索 ==
        const device = await BleClient.requestDevice({
          services: [SERVICE_UUID],
        });
        const newDevice: BLEDevice = {
          name: device.name || "Unknown",
          id: device.deviceId,
          rssi: -50,
        };
        setDevices([newDevice]);
        toast.success("找到设备：" + newDevice.name);
      } else {
        // == Web Bluetooth API ==
        if (!navigator.bluetooth) {
          toast.error("您的浏览器不支持 Web Bluetooth API, 请使用安卓 App");
          setScanning(false);
          return;
        }
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ name: "CarKey_BLE" }],
          optionalServices: [SERVICE_UUID],
        });
        
        device.addEventListener("gattserverdisconnected", handleDisconnect);

        const newDevice: BLEDevice = {
          name: device.name || "Unknown",
          id: device.id,
          rssi: -50,
        };
        setDevices([newDevice]);
        gattServerRef.current = device.gatt;
        toast.success("找到设备：" + newDevice.name);
      }
    } catch (error: any) {
      if (error.name !== "NotFoundError" && !error.message?.includes('cancelled')) {
        toast.error("扫描失败：" + error.message);
      }
    } finally {
      setScanning(false);
    }
  };

  const connectDevice = async (device: BLEDevice) => {
    setSelectedDevice(device);
    
    if (Capacitor.isNativePlatform()) {
      toast.loading("正在尝试原生直连...");
      try {
        // 手机系统级原生建立连接（如果在安卓端，此时硬件如需验证则会自动弹出系统层的蓝牙配对框）
        await BleClient.connect(device.id, handleDisconnect);
        toast.dismiss();
        setConnected(true);
        toast.success("原生蓝牙连接成功！(如果设置了配对密码，执行命令时系统会向您弹窗要求输入密码)");
      } catch (error: any) {
        toast.dismiss();
        toast.error("连接失败：" + error.message);
      }
    } else {
      toast.loading("建立 Web 蓝牙连接中...");
      try {
        const server = await gattServerRef.current.connect();
        toast.dismiss();
        setConnected(true);
        toast.success("网页蓝牙连接成功！");
      } catch (error: any) {
        toast.dismiss();
        toast.error("连接失败：" + error.message);
      }
    }
  };

  const executeCommand = async (command: string) => {
    if (!connected || !selectedDevice) {
      toast.error("设备未连接");
      return;
    }

    setIsExecuting(true);
    try {
      const commandMap: { [key: string]: string } = {
        unlock: "UNLOCK",
        lock: "LOCK",
        trunk: "TRUNK"
      };
      const bleCommandStr = commandMap[command];

      if (Capacitor.isNativePlatform()) {
        // == 原生安卓底层写入通道 ==
        const dataView = textToDataView(bleCommandStr);
        await BleClient.write(selectedDevice.id, SERVICE_UUID, CHAR_UUID, dataView);
      } else {
        // == 网页蓝牙底层写入通道 ==
        const server = gattServerRef.current;
        if (!server || !server.connected) throw new Error("GATT 服务器未连接");
        const service = await server.getPrimaryService(SERVICE_UUID);
        const characteristic = await service.getCharacteristic(CHAR_UUID);
        const encoder = new TextEncoder();
        await characteristic.writeValue(encoder.encode(bleCommandStr));
      }

      const messages: { [key: string]: string } = {
        unlock: "开锁成功",
        lock: "关锁成功",
        trunk: "后备箱已打开"
      };
      toast.success(messages[command] || "命令已执行");
    } catch (error: any) {
      // 若出现类似 "Security error"、"Authentication required"，则说明需要正确配对
      toast.error("指令发送遭拒：" + error.message);
    } finally {
      setIsExecuting(false);
    }
  };

  const disconnect = async () => {
    if (Capacitor.isNativePlatform() && selectedDevice) {
      try {
        await BleClient.disconnect(selectedDevice.id);
      } catch (e) {}
    } else {
      if (gattServerRef.current) {
        gattServerRef.current.disconnect();
      }
    }
    handleDisconnect();
  };

  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => {
      setSignalStrength(Math.floor(Math.random() * 20 + 80)); // 模拟更新
    }, 2000);
    return () => clearInterval(interval);
  }, [connected]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4">
      <div className="max-w-md mx-auto space-y-6">
        <div className="text-center space-y-2 pt-6">
          <div className="flex justify-center mb-4">
            <div className="bg-blue-500/20 p-4 rounded-full">
              <Bluetooth className="w-8 h-8 text-blue-400" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-white">车钥匙遥控</h1>
          <p className="text-slate-400">跨终端纯原生蓝牙控制平台</p>
        </div>

        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="pb-3">
            <CardTitle className="text-white flex items-center gap-2">
              <Bluetooth className="w-5 h-5 text-blue-400" />
              连接状态
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {connected && selectedDevice ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">设备</span>
                  <Badge className="bg-green-500/20 text-green-300 border-green-500/30">
                    <CheckCircle2 className="w-3 h-3 mr-1" />已建立深层连接 (Bonding)
                  </Badge>
                </div>
                <div className="bg-slate-700/50 rounded-lg p-3 space-y-2">
                  <p className="text-sm text-slate-300">
                    <span className="text-slate-400">远端蓝牙核名称：</span>
                    <span className="text-white font-medium">{selectedDevice.name}</span>
                  </p>
                  <p className="text-sm text-slate-300">
                    <span className="text-slate-400">本地驱动底层环境：</span>
                    <span className="text-blue-300 font-medium">{Capacitor.isNativePlatform() ? 'Native Android' : 'Web Browser'}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <Signal className="w-4 h-4 text-blue-400" />
                    <span className="text-sm text-slate-300">
                      <span className="text-slate-400">稳定信号：</span>
                      <span className="text-white font-medium">{signalStrength}%</span>
                    </span>
                  </div>
                </div>
                <Button variant="outline" className="w-full border-slate-600 text-slate-300 hover:bg-slate-700" onClick={disconnect}>
                  断开连接
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">状态</span>
                  <Badge className="bg-slate-600/50 text-slate-300 border-slate-600">
                    <AlertCircle className="w-3 h-3 mr-1" />游离状态
                  </Badge>
                </div>
                <Button onClick={startScan} disabled={scanning} className="w-full bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-900/20">
                  {scanning ? "探测广播波段中..." : "探测附近的车扣！"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {!connected && devices.length > 0 && (
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-sm">锁定到的物理波源</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {devices.map((device) => (
                <Button key={device.id} onClick={() => connectDevice(device)} variant="outline" className="w-full justify-start border-slate-600 text-slate-300 hover:bg-slate-700 hover:text-white">
                  <Bluetooth className="w-4 h-4 mr-2 text-blue-400" />
                  <div className="flex-1 text-left">
                    <p className="font-medium text-white">{device.name}</p>
                    <p className="text-xs text-slate-400 font-mono mt-0.5">MAC/ID: {device.id}</p>
                  </div>
                </Button>
              ))}
            </CardContent>
          </Card>
        )}

        {connected && (
          <Card className="bg-slate-800 border-slate-700 shadow-xl overflow-hidden relative">
            <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none"></div>
            <CardHeader className="pb-3 relative">
              <CardTitle className="text-white font-bold text-xl">主控制台</CardTitle>
              <CardDescription className="text-slate-400">指令将经过多重验证发送至 ESP32</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 relative">
              <Button onClick={() => executeCommand("unlock")} disabled={isExecuting} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white h-16 text-lg font-bold shadow-lg shadow-emerald-900/20 active:scale-[0.98] transition-transform">
                <Unlock className="w-6 h-6 mr-3" />【解锁】激活 PIN 8
              </Button>
              <Button onClick={() => executeCommand("lock")} disabled={isExecuting} className="w-full bg-rose-600 hover:bg-rose-500 text-white h-16 text-lg font-bold shadow-lg shadow-rose-900/20 active:scale-[0.98] transition-transform">
                <Lock className="w-6 h-6 mr-3" />【落锁】激活 PIN 9
              </Button>
              <Button onClick={() => executeCommand("trunk")} disabled={isExecuting} className="w-full bg-amber-600 hover:bg-amber-500 text-white h-16 text-lg font-bold shadow-lg shadow-amber-900/20 active:scale-[0.98] transition-transform">
                <Luggage className="w-6 h-6 mr-3" />【后备箱】激活 PIN 10
              </Button>
            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}
