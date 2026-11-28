#define BLYNK_TEMPLATE_ID "TMPL61Th4g3sH"
#define BLYNK_TEMPLATE_NAME "WaterMI Sensor"
#define BLYNK_DEVICE_NAME "WaterMI Sensor"
#define BLYNK_AUTH_TOKEN "YOUR_AUTH_TOKEN"

#define BLYNK_FIRMWARE_VERSION "1.0.0"
#define BLYNK_PRINT Serial

#include <WiFi.h>
#include <WiFiClient.h>
#include <BlynkSimpleEsp32.h>
#include "DHT.h"

// ---------- Wi-Fi & Blynk settings ----------
// Replace these with your Wi-Fi credentials and Blynk auth token from the Blynk app/console.
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ---------- Pin definitions ----------
#define DHTPIN  4               // DHT22 data pin connected to GPIO 4
#define DHTTYPE DHT22           // Defining sensor type
const int soilMoisturePin = 34; // Soil moisture sensor AO connected to GPIO 34

// Optional analog light sensor (LDR / TEMT6000) on GPIO 35
// Set to true and connect AO to GPIO 35 to enable light readings
const bool LIGHT_SENSOR_ENABLED = false;
const int  lightPin             = 35;

// Soil moisture calibration (ESP32 ADC is 0..4095)
// Adjust these values based on your sensor:
// - SOIL_DRY_RAW: Measure in dry air (typically 3000-4000)
// - SOIL_WET_RAW: Measure in water (typically 0-1000)
const int SOIL_DRY_RAW = 4095;  // Raw value in dry conditions
const int SOIL_WET_RAW = 0;     // Raw value in wet conditions

// How often to send sensor readings to Blynk (ms)
const unsigned long SEND_INTERVAL_MS = 2000;

// Virtual pins on Blynk (match these in your Blynk template)
// V0 = Temperature (°C)
// V1 = Humidity (%)
// V2 = Light (lux)
// V3 = Soil Moisture (%)
#define VPIN_TEMPERATURE  V0
#define VPIN_HUMIDITY     V1
#define VPIN_LIGHT        V2
#define VPIN_SOIL         V3

DHT dht(DHTPIN, DHTTYPE);

BlynkTimer timer;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.print("Connecting to Wi-Fi ");
  Serial.print(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi connected! ESP32 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi connection failed; will retry on next loop.");
  }
}

void sendSensorData() {
  // Read DHT22 values
  float humidity     = dht.readHumidity();
  float temperatureC = dht.readTemperature();

  // Read Soil Moisture analog value (ESP32 ADC is 0 to 4095)
  int soilRaw = analogRead(soilMoisturePin);
  int moisturePercent = map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100);
  moisturePercent = constrain(moisturePercent, 0, 100);

  // Optional Light reading
  int lightLux = 0;
  bool lightConnected = false;
  if (LIGHT_SENSOR_ENABLED) {
    int lightRaw = analogRead(lightPin);
    // Convert ADC reading (0-4095) to approximate lux (0-20000)
    lightLux = map(lightRaw, 0, 4095, 0, 20000);
    lightLux = constrain(lightLux, 0, 20000);
    lightConnected = true;
  }

  // Print to Serial Monitor
  Serial.print("Readings (soilRaw=");
  Serial.print(soilRaw);
  Serial.print("): ");
  Serial.print("Humidity=");
  Serial.print(isnan(humidity) ? "NaN" : String(humidity, 1));
  Serial.print("%, Temp=");
  Serial.print(isnan(temperatureC) ? "NaN" : String(temperatureC, 1));
  Serial.print("°C, Soil=");
  Serial.print(moisturePercent);
  Serial.print("%");
  if (LIGHT_SENSOR_ENABLED) {
    Serial.print(", Light=");
    Serial.print(lightLux);
    Serial.print(" lux");
  }
  Serial.println();

  // Send to Blynk (these update the virtual pins on the Blynk dashboard)
  if (!isnan(humidity))     Blynk.virtualWrite(VPIN_HUMIDITY, humidity);
  if (!isnan(temperatureC)) Blynk.virtualWrite(VPIN_TEMPERATURE, temperatureC);
  Blynk.virtualWrite(VPIN_SOIL, moisturePercent);
  if (LIGHT_SENSOR_ENABLED && lightConnected) Blynk.virtualWrite(VPIN_LIGHT, lightLux);
}

void setup() {
  Serial.begin(115200);
  Serial.println("Initializing WaterMI + Blynk Sensor...");

  dht.begin();

  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) {
    Blynk.config(BLYNK_AUTH_TOKEN);
    Blynk.connect();
  }

  // Schedule sensor readings
  timer.setInterval(SEND_INTERVAL_MS, sendSensorData);
}

void loop() {
  // Ensure Wi-Fi is connected
  connectWiFi();

  // Run Blynk (handles connection, heartbeats, and virtual pin writes)
  if (WiFi.status() == WL_CONNECTED) {
    Blynk.run();
  }

  // Run timer for sensor readings
  timer.run();
}