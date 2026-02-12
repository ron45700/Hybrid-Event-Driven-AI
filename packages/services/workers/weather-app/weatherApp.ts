// ============================================
// WeatherApp Worker
// Fetches weather data from Open-Meteo API
// ============================================

import { createProducer, createConsumer } from '../../shared/kafka-client';
import {
   TOPICS,
   type FunctionExecutionRequest,
   type AppResultMessage,
} from '../../shared/kafka-topics';
import type { Producer, Consumer } from 'kafkajs';

// Open-Meteo API URLs
const GEOCODING_API = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

// Type definitions
interface GeocodingResult {
   latitude: number;
   longitude: number;
   name: string;
   country: string;
}

interface GeocodingResponse {
   results?: GeocodingResult[];
}

interface WeatherResponse {
   current: {
      temperature_2m: number;
      weather_code: number;
      wind_speed_10m: number;
   };
}

let producer: Producer;
let consumer: Consumer;
let isRunning = false;

/**
 * Get weather description from WMO code (Hebrew)
 */
function getWeatherDescription(code: number): string {
   const descriptions: Record<number, string> = {
      0: 'שמיים בהירים',
      1: 'בהיר ברובו',
      2: 'מעונן חלקית',
      3: 'מעונן',
      45: 'ערפל',
      48: 'ערפל',
      51: 'טפטוף קל',
      53: 'טפטוף',
      55: 'טפטוף כבד',
      61: 'גשם קל',
      63: 'גשם',
      65: 'גשם כבד',
      71: 'שלג קל',
      73: 'שלג',
      75: 'שלג כבד',
      80: 'ממטרים קלים',
      81: 'ממטרים',
      82: 'ממטרים עזים',
      95: 'סופת רעמים',
   };
   return descriptions[code] || 'לא ידוע';
}

/**
 * Fetch weather for a city
 */
async function getWeather(city: string): Promise<string> {
   try {
      // Step 1: Get coordinates
      const geoResponse = await fetch(
         `${GEOCODING_API}?name=${encodeURIComponent(city)}&count=1`
      );
      const geoData = (await geoResponse.json()) as GeocodingResponse;

      if (!geoData.results || geoData.results.length === 0) {
         return `לא נמצא מיקום: ${city}`;
      }

      const location = geoData.results[0]!;
      const { latitude, longitude, name, country } = location;

      // Step 2: Get weather
      const weatherResponse = await fetch(
         `${WEATHER_API}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m`
      );
      const weatherData = (await weatherResponse.json()) as WeatherResponse;

      const { temperature_2m, weather_code, wind_speed_10m } =
         weatherData.current;
      const weatherDesc = getWeatherDescription(weather_code);

      return `מזג האוויר ב-${name}, ${country}: ${temperature_2m}°C, ${weatherDesc}, רוח: ${wind_speed_10m} קמ"ש`;
   } catch (error) {
      console.error('WeatherApp: API error:', error);
      return `שגיאה בקבלת מזג אוויר עבור ${city}`;
   }
}

/**
 * Start the WeatherApp worker
 */
async function start(): Promise<void> {
   if (isRunning) return;

   console.log('🔌 WeatherApp: Starting...');

   producer = createProducer();
   consumer = createConsumer('weather-app-group');

   await producer.connect();
   await consumer.connect();
   await consumer.subscribe({
      topic: TOPICS.ENRICHED_EXECUTION,
      fromBeginning: false,
   });

   await consumer.run({
      eachMessage: async ({ message }) => {
         if (!message.value) return;

         try {
            const execRequest: FunctionExecutionRequest = JSON.parse(
               message.value.toString()
            );

            // Only process weather requests
            if (execRequest.functionName !== 'weather') return;

            console.log(
               `📥 WeatherApp: Processing [${execRequest.correlationId}]`
            );

            // Get city from parameters
            const city =
               (execRequest.parameters as { city?: string }).city || '';
            const response = await getWeather(city);

            // Publish result
            const result: AppResultMessage = {
               correlationId: execRequest.correlationId,
               timestamp: Date.now(),
               source: 'weather',
               prompt: city,
               response,
               sessionId: execRequest.sessionId,
            };

            await producer.send({
               topic: TOPICS.APP_RESULTS,
               messages: [{ value: JSON.stringify(result) }],
            });

            console.log(
               `📤 WeatherApp: Published result [${execRequest.correlationId}]`
            );
         } catch (error) {
            console.error('WeatherApp: Error processing message:', error);
         }
      },
   });

   isRunning = true;
   console.log('✅ WeatherApp: Running');
}

/**
 * Stop the WeatherApp worker
 */
async function stop(): Promise<void> {
   console.log('🔌 WeatherApp: Stopping...');
   await consumer?.disconnect();
   await producer?.disconnect();
   isRunning = false;
   console.log('✅ WeatherApp: Stopped');
}

export const weatherApp = { start, stop };

// Run as standalone
if (import.meta.main) {
   start().catch(console.error);
   process.on('SIGINT', async () => {
      await stop();
      process.exit(0);
   });
   process.on('SIGTERM', async () => {
      await stop();
      process.exit(0);
   });
}
