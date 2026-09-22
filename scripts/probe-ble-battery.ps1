param(
  [Parameter(Mandatory = $true)]
  [string]$Address
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Devices.Bluetooth.BluetoothLEDevice,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceService,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristic,Windows.Devices.Bluetooth,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IBuffer,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class WinRtBufferReader {
  [ComImport]
  [Guid("905a0fef-bc53-11df-8c49-001e4fc686da")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IBufferByteAccess {
    IntPtr Buffer();
  }

  public static byte ReadFirstByte(object buffer) {
    var access = (IBufferByteAccess)buffer;
    return Marshal.ReadByte(access.Buffer());
  }
}
"@

function Await-WinRt($operation, $resultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' `
        -and $_.GetParameters().Count -eq 1 `
        -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  $task.Result
}

$bluetoothAddress = [Convert]::ToUInt64($Address, 16)
$device = Await-WinRt ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($bluetoothAddress)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])

Write-Output "Device: $($device.Name)"

$serviceGuid = [Guid]'0000180f-0000-1000-8000-00805f9b34fb'
$services = Await-WinRt ($device.GetGattServicesForUuidAsync($serviceGuid)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattDeviceServicesResult])

Write-Output "Services status: $($services.Status), count: $($services.Services.Count)"

foreach ($service in $services.Services) {
  $characteristicGuid = [Guid]'00002a19-0000-1000-8000-00805f9b34fb'
  $characteristics = Await-WinRt ($service.GetCharacteristicsForUuidAsync($characteristicGuid)) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicsResult])

  Write-Output "Characteristics status: $($characteristics.Status), count: $($characteristics.Characteristics.Count)"

  foreach ($characteristic in $characteristics.Characteristics) {
    $read = Await-WinRt ($characteristic.ReadValueAsync()) ([Windows.Devices.Bluetooth.GenericAttributeProfile.GattReadResult])

    Write-Output "Read status: $($read.Status)"

    if ($read.Status -eq 'Success') {
      Write-Output "Battery: $([WinRtBufferReader]::ReadFirstByte($read.Value))"
    }
  }
}
