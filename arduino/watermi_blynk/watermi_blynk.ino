#define BLYNK_TEMPLATE_ID "YOUR_TEMPLATE_ID"
#define BLYNK_TEMPLATE_NAME "WaterMI Sensor"
#define BLYNK_DEVICE_NAME "WaterMI Sensor"
#define BLYNK_AUTH_TOKEN "YOUR_AUTH_TOKEN"

#define BLYNK_FIRMWARE_VERSION "1.1.0"
// Uncomment only for local serial troubleshooting (prints connection metadata to UART):
// #define BLYNK_PRINT Serial

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <BlynkSimpleEsp32_SSL.h>
#include <DHT.h>
#include <esp_task_wdt.h>
#include <math.h>

// ---------- Wi-Fi & Blynk settings ----------
const char* WIFI_SSID     = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ---------- Pin definitions ----------
#define DHTPIN  4               // DHT22 data pin connected to GPIO 4
#define DHTTYPE DHT22           // Defining sensor type
const int soilMoisturePin = 34; // Soil moisture sensor AO connected to GPIO 34

const bool LIGHT_SENSOR_ENABLED = true;
const int  lightPin             = 35;

// Soil moisture calibration (ESP32 ADC is 0..4095; dry and wet values must differ)
const int SOIL_DRY_RAW = 4095;  // Raw value in dry conditions
const int SOIL_WET_RAW = 0;     // Raw value in wet conditions

// How often to send sensor readings to Blynk (ms, minimum 1000)
const unsigned long SEND_INTERVAL_MS = 2000;

// Hardware watchdog timeout (seconds) & multi-sample ADC averaging count
const uint32_t WDT_TIMEOUT_SEC = 30;
const int ADC_SAMPLES = 8;

// Virtual pins on Blynk (matched to your Blynk Datastreams)
// V0 = Temperature (°C, valid range -40..80)
// V1 = Humidity (%, valid range 0..100)
// V2 = Ambient Light (raw 12-bit ADC 0..4095)
// V3 = Soil Moisture (%, 0..100)
#define VPIN_TEMPERATURE V0
#define VPIN_HUMIDITY    V1
#define VPIN_LIGHT       V2
#define VPIN_SOIL        V3

DHT dht(DHTPIN, DHTTYPE);
BlynkTimer timer;

unsigned long lastWiFiAttemptMs = 0;
unsigned long wifiBackoffMs = 2000;
unsigned long lastBlynkAttemptMs = 0;

int readAveragedAdc(int pin) {
  long total = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    total += analogRead(pin);
  }
  return (int)(total / ADC_SAMPLES);
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiBackoffMs = 2000;
    return;
  }
  unsigned long now = millis();
  if (lastWiFiAttemptMs != 0 && (now - lastWiFiAttemptMs) < wifiBackoffMs) {
    return;
  }
  lastWiFiAttemptMs = now;

  Serial.println("Connecting to Wi-Fi...");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Exponential backoff up to 60s without blocking the main loop or watchdog
  if (wifiBackoffMs < 60000) {
    wifiBackoffMs = min(60000UL, wifiBackoffMs * 2);
  }
}

void ensureBlynk() {
  if (WiFi.status() != WL_CONNECTED || Blynk.connected()) return;
  unsigned long now = millis();
  if (lastBlynkAttemptMs != 0 && (now - lastBlynkAttemptMs) < 5000) return;
  lastBlynkAttemptMs = now;
  Blynk.connect(3000);
}

void sendSensorData() {
  if (WiFi.status() != WL_CONNECTED || !Blynk.connected()) return;

  // Read DHT22 values and validate physical bounds
  float humidity     = dht.readHumidity();
  float temperatureC = dht.readTemperature();
  bool tempOk = !isnan(temperatureC) && !isinf(temperatureC) && temperatureC >= -40.0f && temperatureC <= 80.0f;
  bool humOk  = !isnan(humidity) && !isinf(humidity) && humidity >= 0.0f && humidity <= 100.0f;

  // Read Soil Moisture analog value (ESP32 ADC is 0 to 4095) with divide-by-zero guard
  int soilRaw = readAveragedAdc(soilMoisturePin);
  int moisturePercent = 0;
  if (SOIL_DRY_RAW != SOIL_WET_RAW) {
    moisturePercent = map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100);
    moisturePercent = constrain(moisturePercent, 0, 100);
  }

  // Read Light Sensor (0 to 4095 to match Blynk V2 Datastream Max = 4095)
  int lightRaw = 0;
  if (LIGHT_SENSOR_ENABLED) {
    lightRaw = readAveragedAdc(lightPin);
    lightRaw = constrain(lightRaw, 0, 4095);
  }

  // Stack-allocated serial log (avoids String heap fragmentation)
  char line[140];
  char tempBuf[12];
  char humBuf[12];
  if (tempOk) snprintf(tempBuf, sizeof(tempBuf), "%.1f", temperatureC);
  else snprintf(tempBuf, sizeof(tempBuf), "ERR");
  if (humOk) snprintf(humBuf, sizeof(humBuf), "%.1f", humidity);
  else snprintf(humBuf, sizeof(humBuf), "ERR");

  if (LIGHT_SENSOR_ENABLED) {
    snprintf(line, sizeof(line), "Readings (soilRaw=%d): Temp=%s C, Humidity=%s%%, Soil=%d%%, Light=%d",
             soilRaw, tempBuf, humBuf, moisturePercent, lightRaw);
  } else {
    snprintf(line, sizeof(line), "Readings (soilRaw=%d): Temp=%s C, Humidity=%s%%, Soil=%d%%",
             soilRaw, tempBuf, humBuf, moisturePercent);
  }
  Serial.println(line);

  // Send validated readings over TLS to Blynk Cloud
  if (tempOk) Blynk.virtualWrite(VPIN_TEMPERATURE, temperatureC);
  if (humOk)  Blynk.virtualWrite(VPIN_HUMIDITY, humidity);
  if (LIGHT_SENSOR_ENABLED) Blynk.virtualWrite(VPIN_LIGHT, lightRaw);
  Blynk.virtualWrite(VPIN_SOIL, moisturePercent);
}

void setup() {
  Serial.begin(115200);
  Serial.println("Initializing WaterMI + Blynk TLS Sensor...");

  // Configure hardware watchdog so hung network/sensor calls recover automatically
#if defined(ESP_IDF_VERSION_MAJOR) && ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdtConfig = {
    .timeout_ms = WDT_TIMEOUT_SEC * 1000,
    .idle_core_mask = 0,
    .trigger_panic = true
  };
  esp_task_wdt_reconfigure(&wdtConfig);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif
  esp_task_wdt_add(NULL);

  dht.begin();

  // Always configure Blynk unconditionally so recovery works even if Wi-Fi is down at boot
  Blynk.config(BLYNK_AUTH_TOKEN);
  ensureWiFi();
  ensureBlynk();

  unsigned long interval = SEND_INTERVAL_MS < 1000 ? 1000 : SEND_INTERVAL_MS;
  timer.setInterval(interval, sendSensorData);
}

void loop() {
  esp_task_wdt_reset();

  ensureWiFi();
  ensureBlynk();

  if (WiFi.status() == WL_CONNECTED && Blynk.connected()) {
    Blynk.run();
  }

  timer.run();
}
