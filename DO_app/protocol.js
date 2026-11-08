/** YINMIK BLE-9100 FF01/FF02 decoder. */
export const BLE9100_SERVICE = 0xff01;
export const BLE9100_CHARACTERISTIC = 0xff02;
export const BLE9100_FRAME_LENGTH = 24;

/**
 * Undo the BLE-9100's adjacent-byte bit-pair transform.
 * The operation order mirrors the published BLE-9100 decoder: iterate from
 * the end of the frame, update each neighboring pair in place, and truncate
 * the bitwise complement to an unsigned byte.
 */
export function decodeFrame(input) {
  const source = input instanceof Uint8Array ? input : Uint8Array.from(input);
  if (source.length !== BLE9100_FRAME_LENGTH) {
    throw new RangeError(`Expected ${BLE9100_FRAME_LENGTH} bytes; received ${source.length}.`);
  }

  const data = Uint8Array.from(source);
  for (let i = data.length - 1; i > 0; i -= 1) {
    const current = data[i];
    const currentEvenShifted = (current & 0x55) << 1;
    const currentOddShifted = (current & 0xaa) >>> 1;
    const previous = data[i - 1];
    const previousEvenShifted = (previous & 0x55) << 1;
    const previousOddShifted = (previous & 0xaa) >>> 1;

    data[i] = ~(currentEvenShifted | previousOddShifted) & 0xff;
    data[i - 1] = ~(previousEvenShifted | currentOddShifted) & 0xff;
  }

  const word = (highIndex) => (data[highIndex] << 8) | data[highIndex + 1];
  const reading = {
    dissolvedOxygenMgL: word(3) / 100,
    saturationPercent: word(5) / 10,
    temperatureC: word(13) / 10,
    batteryPercent: word(15) / 31.9,
    orpMv: word(20),
    decodedBytes: data,
  };

  if (!Number.isFinite(reading.dissolvedOxygenMgL) || reading.dissolvedOxygenMgL < 0 || reading.dissolvedOxygenMgL > 30) {
    throw new RangeError(`Decoded DO value ${reading.dissolvedOxygenMgL} mg/L is outside the BLE-9100 range.`);
  }
  if (!Number.isFinite(reading.saturationPercent) || reading.saturationPercent < 0 || reading.saturationPercent > 300) {
    throw new RangeError(`Decoded saturation ${reading.saturationPercent}% is outside the BLE-9100 range.`);
  }
  if (!Number.isFinite(reading.temperatureC) || reading.temperatureC < 0 || reading.temperatureC > 50) {
    throw new RangeError(`Decoded temperature ${reading.temperatureC} °C is outside the expected range.`);
  }

  return reading;
}

export function hexBytes(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}
