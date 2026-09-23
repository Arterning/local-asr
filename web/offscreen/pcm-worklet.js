class Pcm16Resampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetSampleRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.position = 0;
    this.buffer = [];
    this.output = [];
    this.chunkSamples = 1600;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i += 1) this.buffer.push(input[i]);

    while (this.position + 1 < this.buffer.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const sample = this.buffer[left] * (1 - fraction) + this.buffer[left + 1] * fraction;
      this.output.push(Math.max(-1, Math.min(1, sample)));
      this.position += this.ratio;
    }

    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.buffer.splice(0, consumed);
      this.position -= consumed;
    }

    while (this.output.length >= this.chunkSamples) {
      const pcm = new Int16Array(this.chunkSamples);
      for (let i = 0; i < pcm.length; i += 1) {
        const value = this.output[i];
        pcm[i] = value < 0 ? value * 32768 : value * 32767;
      }
      this.output.splice(0, this.chunkSamples);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    return true;
  }
}

registerProcessor("pcm16-resampler", Pcm16Resampler);
