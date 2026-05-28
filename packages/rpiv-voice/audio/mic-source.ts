import { EventEmitter } from "node:events";
import { computeRmsInt16 } from "./pcm.js";
import { Int16LinearResampler } from "./resampler.js";

// Public 16 kHz target — Whisper's input rate, also the only rate the
// downstream pipeline understands (segment caps, RMS thresholds, etc. are
// all expressed in 16 kHz samples). `FRAMES_PER_BUFFER` is the chunk size
// at the target rate; capture is sized proportionally so each forwarded
// chunk lands on roughly the same 100 ms cadence regardless of device.
export const TARGET_SAMPLE_RATE = 16000;
export const FRAMES_PER_BUFFER = 1600;

// JS-side VAD parameters. We can't use decibri's Silero here because
// Silero only supports 8/16 kHz and we capture at the device's native rate
// (commonly 48 kHz on macOS built-in mics, which Silero would reject at
// the ctor). The energy gate is cruder than Silero but adequate for
// dictation: the 500 ms holdoff is the real de-bouncer.
//
// VAD_RMS_THRESHOLD sits between the hallucination floor in
// pipeline-runner (0.005 ≈ -46 dBFS, treated as "no audible content") and
// quiet speech (~-30 dBFS). 0.015 ≈ -36 dBFS catches soft speech without
// triggering on typical room noise.
const VAD_RMS_THRESHOLD = 0.015;

// Hangover before emitting `silence`. decibri's 300 ms default flushed
// mid-clause at natural breath pauses, which forced Whisper to "complete"
// an unterminated phrase with a spurious period. 700 ms eliminated that
// but felt laggy at the user-perceived "I stopped → text appears" gap.
// 500 ms is the LiveKit value: covers most natural breath pauses, keeps
// the perceived gap to ~half a second, and the transcribing spinner now
// papers over the rest.
const VAD_HOLDOFF_MS = 500;

// Tried in order if the default input device's `defaultSampleRate` isn't
// available or that rate also fails. 48 kHz first because it's the macOS
// built-in mic native rate and the cpal/CoreAudio common ground; 44.1 kHz
// next because it's near-universal on USB audio; 96 kHz last as a hedge
// for newer Apple Silicon mics.
const FALLBACK_CAPTURE_RATES = [48000, 44100, 96000] as const;

// Upper bound on how long we wait for either the first `data` event
// (success) or an `error` event (device refused our config) before
// resolving `createMic` optimistically. cpal/decibri surfaces config
// rejection within tens of milliseconds in practice; 1.5 s is comfortable
// headroom without making `/voice` feel laggy when the mic genuinely
// takes a moment to start producing samples.
const STARTUP_RACE_MS = 1500;

export interface DecibriLike {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	on(event: "speech" | "silence", listener: () => void): unknown;
	once(event: "end" | "error" | "close", listener: (err?: Error) => void): unknown;
	stop(): void;
}

interface DecibriDevice {
	index: number;
	name: string;
	id?: string;
	maxInputChannels: number;
	defaultSampleRate: number;
	isDefault: boolean;
}

interface DecibriRaw extends EventEmitter {
	stop(): void;
}

interface DecibriCtor {
	new (opts: Record<string, unknown>): DecibriRaw;
	devices?(): DecibriDevice[];
}

export async function createMic(): Promise<DecibriLike> {
	// decibri ships as CJS (`module.exports = Decibri`); under ESM the ctor lands on `.default`.
	const mod = (await import("decibri")) as { default: DecibriCtor };
	const Decibri = mod.default;

	const rates = pickCaptureRates(Decibri);
	let lastError: Error | null = null;
	for (const rate of rates) {
		try {
			return await openMicAtRate(Decibri, rate);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}
	throw lastError ?? new Error("Failed to open microphone at any supported sample rate");
}

function pickCaptureRates(Decibri: DecibriCtor): number[] {
	let defaultRate: number | null = null;
	try {
		const devices = typeof Decibri.devices === "function" ? Decibri.devices() : [];
		const def = devices.find((d) => d.isDefault && d.maxInputChannels >= 1);
		if (def && def.defaultSampleRate > 0) defaultRate = def.defaultSampleRate;
	} catch {
		// Device enumeration is best-effort. A bug or platform quirk here
		// must not block capture — fall through to the fixed fallback list.
	}

	const ordered: number[] = [];
	if (defaultRate !== null) ordered.push(defaultRate);
	for (const r of FALLBACK_CAPTURE_RATES) {
		if (!ordered.includes(r)) ordered.push(r);
	}
	return ordered;
}

function openMicAtRate(Decibri: DecibriCtor, sourceRate: number): Promise<DecibriLike> {
	return new Promise<DecibriLike>((resolve, reject) => {
		// Capture buffer scaled to preserve the ~100 ms chunk cadence the
		// pipeline was tuned against (1600 samples at 16 kHz = 100 ms).
		const captureBufferFrames = Math.max(1, Math.round((FRAMES_PER_BUFFER * sourceRate) / TARGET_SAMPLE_RATE));

		let raw: DecibriRaw;
		try {
			raw = new Decibri({
				sampleRate: sourceRate,
				channels: 1,
				framesPerBuffer: captureBufferFrames,
				format: "int16",
				// Silero refuses non-8/16 kHz. We run an RMS energy gate in JS
				// on the resampled 16 kHz stream instead — see MicAdapter.
				vad: false,
			});
		} catch (err) {
			reject(decoratedError(err, sourceRate));
			return;
		}

		const wrapper = new MicAdapter(raw, sourceRate);
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			raw.removeListener("error", onError);
			raw.removeListener("data", onData);
			fn();
		};
		const onError = (err: unknown) =>
			settle(() => {
				try {
					raw.stop();
				} catch {
					// stop() can throw if the stream never opened; we're already
					// rejecting with the underlying error, no need to chain.
				}
				reject(decoratedError(err, sourceRate));
			});
		const onData = () => settle(() => resolve(wrapper));
		const onTimeout = () => settle(() => resolve(wrapper));

		const timer = setTimeout(onTimeout, STARTUP_RACE_MS);
		raw.once("error", onError);
		raw.once("data", onData);
	});
}

function decoratedError(err: unknown, sourceRate: number): Error {
	const message = err instanceof Error ? err.message : String(err);
	const decorated = new Error(`mic open failed at ${sourceRate} Hz: ${message}`);
	if (err instanceof Error && err.stack) decorated.stack = err.stack;
	return decorated;
}

// Wraps a raw decibri instance: resamples int16 chunks to 16 kHz, runs an
// RMS-energy silence detector on the resampled stream, and forwards
// `data`, `silence`, `end`, `error`, `close` events. `speech` is not
// emitted — the pipeline doesn't consume it.
//
// Events emitted before any consumer attaches a listener are queued and
// drained on a microtask after the first listener registration. This
// closes the gap between `createMic()` resolving and the pipeline runner
// attaching its listeners (splash teardown + caller plumbing): without
// the queue, early audio would be dropped and — worse — an early `error`
// would throw "Unhandled error" from EventEmitter.
class MicAdapter extends EventEmitter implements DecibriLike {
	private readonly raw: DecibriRaw;
	private readonly resampler: Int16LinearResampler;
	private readonly pending: Array<{ event: string; args: unknown[] }> = [];
	private drained = false;

	private inSpeech = false;
	private silenceTimer: NodeJS.Timeout | null = null;

	constructor(raw: DecibriRaw, sourceRate: number) {
		super();
		this.raw = raw;
		this.resampler = new Int16LinearResampler(sourceRate, TARGET_SAMPLE_RATE);

		const onNewListener = (event: string) => {
			// `newListener` fires for *any* event registration including
			// `newListener` itself; ignore the self-trigger so we drain on
			// the first real consumer attach.
			if (this.drained || event === "newListener") return;
			this.drained = true;
			this.removeListener("newListener", onNewListener);
			// Defer drain until the just-being-added listener is actually in
			// the internal array (newListener fires *before* the add).
			queueMicrotask(() => {
				for (const item of this.pending) this.emit(item.event, ...item.args);
				this.pending.length = 0;
			});
		};
		this.on("newListener", onNewListener);

		raw.on("data", (chunk: Buffer) => this.onRawData(chunk));
		raw.once("end", () => this.emitOrQueue("end"));
		raw.once("error", (err: Error) => this.emitOrQueue("error", err));
		raw.once("close", () => this.emitOrQueue("close"));
	}

	stop(): void {
		if (this.silenceTimer) {
			clearTimeout(this.silenceTimer);
			this.silenceTimer = null;
		}
		this.raw.stop();
	}

	private onRawData(chunk: Buffer): void {
		const resampled = this.resampler.process(chunk);
		if (resampled.length === 0) return;
		this.emitOrQueue("data", resampled);
		this.runSilenceDetector(resampled);
	}

	private runSilenceDetector(chunk: Buffer): void {
		const rms = computeRmsInt16(chunk);
		if (rms >= VAD_RMS_THRESHOLD) {
			this.inSpeech = true;
			if (this.silenceTimer) {
				clearTimeout(this.silenceTimer);
				this.silenceTimer = null;
			}
			return;
		}
		if (this.inSpeech && this.silenceTimer === null) {
			this.silenceTimer = setTimeout(() => {
				this.silenceTimer = null;
				this.inSpeech = false;
				this.emitOrQueue("silence");
			}, VAD_HOLDOFF_MS);
		}
	}

	private emitOrQueue(event: string, ...args: unknown[]): void {
		if (this.drained) {
			this.emit(event, ...args);
		} else {
			this.pending.push({ event, args });
		}
	}
}
