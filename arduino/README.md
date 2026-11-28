# WaterMI ESP32 + Blynk sensor setup

Send live **humidity**, **temperature**, **soil moisture** and optional **light** readings from an ESP32 to **Blynk IoT**, then view in the Blynk app or web dashboard.

## The easy way: use the setup page

1. Open your WaterMI site and click the **Sensors** tab in the top navigation.
2. **Create a Blynk device** — Open <https://blynk.cloud>, create a new device template (or use existing). Note your **Template ID** (e.g., `TMPLxxxxxx`) and **Auth Token**.
3. **Configure & download** — Enter Wi-Fi (2.4 GHz only), your Blynk Template ID & Auth Token, choose your GPIO pins in the dropdowns, click **Download sketch**.
4. **Flash to ESP32** — Open the downloaded `watermi_blynk.ino` in Arduino IDE. Install **Blynk** library (Sketch → Include Library → Manage Libraries → search "Blynk"). Select board & port. Click **Upload**. Open Serial Monitor at 115200 baud — you should see "Wi-Fi connected!" and Blynk connection.
5. **Watch live data in Blynk** — Open the Blynk app (mobile or web). Add Gauge/Value Display widgets for:
   - **V0** = Temperature (°C)
   - **V1** = Humidity (%)
   - **V2** = Light (lux)
   - **V3** = Soil Moisture (%)
   Data appears every 2 seconds.

## What you need

- ESP32 board with Wi-Fi (2.4 GHz only, 5 GHz does not work)
- DHT22 temperature and humidity sensor
- Analog soil moisture sensor with an `AO` pin
- *(Optional)* Analog light sensor (LDR or TEMT6000)
- Jumper wires and a USB cable
- Blynk account (free tier works)

## Wiring

| Sensor | Sensor pin | ESP32 pin |
| --- | --- | --- |
| DHT22 | VCC | `3.3V` |
| DHT22 | DATA | `GPIO 4` (default) — changeable in setup page |
| DHT22 | GND | `GND` |
| Soil moisture | VCC | `3.3V` |
| Soil moisture | AO | `GPIO 34` (default) — ADC1 pins 32–39 |
| Soil moisture | GND | `GND` |
| Light *(optional)* | AO | `GPIO 35` (default) — ADC1 pins 32–39 |

**ADC1 pins (32–39)** keep working while Wi-Fi is active. Avoid GPIO 6–11 for DHT22 (strapped pins). A bare DHT22 (not on a breakout board) needs a 10 kΩ resistor between DATA and `3.3V`.

## One-time Arduino IDE setup

1. Install [Arduino IDE](https://www.arduino.cc/en/software).
2. **Tools → Board → Boards Manager**: install **esp32** by Espressif Systems.
3. **Sketch → Include Library → Manage Libraries**: install **Blynk** by Volodymyr Shymanskyy. Also install **DHT sensor library** by Adafruit (accept **Adafruit Unified Sensor** dependency).
4. Choose your ESP32 board and port under **Tools**, then click **Upload**.
5. Open **Serial Monitor** at `115200` baud. You should see `Wi-Fi connected!` and Blynk connection messages.

## Editing the sketch by hand

Open [watermi_blynk/watermi_blynk.ino](watermi_blynk/watermi_blynk.ino) and customize these constants at the top:

```cpp
// Wi-Fi credentials
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Blynk settings (get from Blynk Console → Device → Template)
#define BLYNK_TEMPLATE_ID "YOUR_TEMPLATE_ID"
#define BLYNK_DEVICE_NAME "WaterMI Sensor"
#define BLYNK_AUTH_TOKEN  "YOUR_AUTH_TOKEN"

// Pin assignments (edit these to match your wiring)
#define DHTPIN  4               // DHT22 data pin
#define DHTTYPE DHT22
const int soilMoisturePin = 34; // Soil moisture AO pin
const bool LIGHT_SENSOR_ENABLED = false;  // Set to true to enable light sensor
const int  lightPin             = 35;     // Light sensor AO pin

// Soil calibration (adjust based on your sensor)
const int SOIL_DRY_RAW = 4095;   // Raw value in dry air
const int SOIL_WET_RAW = 0;      // Raw value in water

// How often to send readings (milliseconds)
const unsigned long SEND_INTERVAL_MS = 2000;

// Blynk virtual pins (match widgets in Blynk app)
#define VPIN_TEMPERATURE  V0
#define VPIN_HUMIDITY     V1
#define VPIN_LIGHT        V2
#define VPIN_SOIL         V3
```

### Customization Options

- **BLYNK_TEMPLATE_ID / BLYNK_AUTH_TOKEN**: Get from Blynk Console → Device → Template.
- **LIGHT_SENSOR_ENABLED**: Set to `true` and wire an analog light sensor to GPIO 35.
- **SOIL_DRY_RAW / SOIL_WET_RAW**: Calibrate for your specific sensor (measure in dry air and in water).
- **SEND_INTERVAL_MS**: Lower for faster updates (minimum 1000ms), higher for less frequent uploads.
- **VPIN_HUMIDITY / VPIN_TEMPERATURE / VPIN_SOIL / VPIN_LIGHT**: Virtual pin numbers. Match these to your Blynk widgets.

## Blynk widget setup

In Blynk Console or mobile app, add **Value Display** or **Gauge** widgets:

| Virtual Pin | Label | Unit | Range |
| --- | --- | --- | --- |
| V0 | Temperature | °C | -40–80 |
| V1 | Humidity | % | 0–100 |
| V2 | Light | lux | 0–20000 |
| V3 | Soil Moisture | % | 0–100 |

Set reading rate to "Push" (not Poll) since the ESP32 pushes data.

## Soil moisture calibration

Every probe reads a little differently.

1. In Serial Monitor, hold the probe in dry air and note `soilRaw=...`. Put that number in `SOIL_DRY_RAW`.
2. Dip the probe up to its marked line (never the electronics) in a cup of water and note `soilRaw=...`. Put that in `SOIL_WET_RAW`.
3. Upload again.

## How it works

The sketch sends sensor values to Blynk virtual pins every 2 seconds using `Blynk.virtualWrite()`. Blynk handles the cloud connection, device management, and dashboard widgets.

- Values appear in real-time on Blynk web/mobile dashboards.
- If Wi-Fi drops, the sketch reconnects automatically.
- `null`/NaN values are not sent (sensor shows as disconnected in Blynk).

Test without hardware (simulate device in Blynk):

```bash
# Not needed — Blynk handles device communication
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Never connects to Wi-Fi | Use a 2.4 GHz network and check the name and password. |
| "Invalid Auth Token" in Serial Monitor | Re-check Template ID & Auth Token from Blynk Console. They must match the device. |
| Blynk shows "Device offline" | Check Wi-Fi, restart ESP32, verify Auth Token matches the device in Blynk. |
| Humidity and temperature show NaN | Check the DHT22 data wire on selected GPIO and its 3.3V and GND. Add 10 kΩ pull-up if bare sensor. |
| Soil moisture stuck at 0% or 100% | Calibrate SOIL_DRY_RAW / SOIL_WET_RAW in Advanced options (measure in dry air and water). |
| All sensors drop after ~30s | Board stopped — check power supply (use USB or stable 5V) & Wi-Fi stability. |
| "Blynk library not found" | Install Blynk library in Arduino IDE: Sketch → Include Library → Manage Libraries → search "Blynk". |
