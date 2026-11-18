// Audio worklet for local dictation: forwards mono microphone samples to the
// page in ~85 ms batches. It never stores, encodes or sends audio anywhere.
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(4096);
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      if (this.length + channel.length > this.batch.length) {
        this.port.postMessage(this.batch.slice(0, this.length));
        this.length = 0;
      }
      this.batch.set(channel, this.length);
      this.length += channel.length;
    }
    return true;
  }
}
registerProcessor("dictation-capture", DictationCapture);
