import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// State is hoisted alongside vi.mock so the factory can reach it. The mock
// factory cannot reference imports from this file (vi.mock is hoisted
// above imports) and cannot be async, so we ship a tiny self-contained
// EventEmitter shim instead of pulling in node:events.
const state = vi.hoisted(() => ({
	instances: [],
	devices: [],
}));

vi.mock("decibri", () => {
	type Listener = (...args: unknown[]) => void;
	class MockMic {
		opts: Record<string, unknown>;
		stop = vi.fn();
		_listeners: Record<string, Listener[]> = {};
		constructor(opts: Record<string, unknown>) {
			this.opts = opts;
			(state.instances as MockMic[]).push(this);
		}
		on(event: string, fn: Listener): this {
			const list = this._listeners[event] ?? [];
			list.push(fn);
			this._listeners[event] = list;
			return this;
		}
		once(event: string, fn: Listener): this {
			const wrap: Listener = (...args) => {
				this.removeListener(event, wrap);
				fn(...args);
			};
			return this.on(event, wrap);
		}
		removeListener(event: string, fn: Listener): this {
			const list = this._listeners[event];
			if (!list) return this;
			const idx = list.indexOf(fn);
			if (idx >= 0) list.splice(idx, 1);
			return this;
		}
		emit(event: string, ...args: unknown[]): boolean {
			const list = this._listeners[event];
			if (!list) return false;
			for (const fn of [...list]) fn(...args);
			return true;
		}
		static devices(): unknown[] {
			return state.devices;
		}
	}
	return { default: MockMic };
});

import { createMic, FRAMES_PER_BUFFER, TARGET_SAMPLE_RATE } from "./mic-source.js";

interface MockMicInstance {
	opts: Record<string, unknown>;
	stop: ReturnType<typeof vi.fn>;
	emit(event: string, ...args: unknown[]): boolean;
}

function instances(): MockMicInstance[] {
	return state.instances as unknown as MockMicInstance[];
}

const BUILT_IN_MIC = {
	index: 0,
	name: "MacBook Pro Microphone",
	id: "coreaudio:BuiltInMicrophoneDevice",
	maxInputChannels: 1,
	defaultSampleRate: 48000,
	isDefault: true,
};

beforeEach(() => {
	state.instances.length = 0;
	(state.devices as unknown as unknown[]).length = 0;
	(state.devices as unknown as unknown[]).push(BUILT_IN_MIC);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function setDevices(d: unknown[]): void {
	const arr = state.devices as unknown as unknown[];
	arr.length = 0;
	for (const item of d) arr.push(item);
}

describe("createMic — capture rate selection", () => {
	it("opens decibri at the default device's defaultSampleRate, not 16 kHz", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		await micPromise;

		const opts = instances()[0]?.opts ?? {};
		expect(opts.sampleRate).toBe(48000);
		expect(opts.channels).toBe(1);
		expect(opts.format).toBe("int16");
		// Silero rejects non-8/16 kHz; the wrapper runs an RMS gate instead.
		expect(opts.vad).toBe(false);
		// Capture buffer scaled to keep the ~100 ms forwarding cadence
		// (1600 samples @ 16 kHz → 4800 samples @ 48 kHz).
		expect(opts.framesPerBuffer).toBe(4800);
	});

	it("falls back to 48 kHz when device enumeration yields nothing useful", async () => {
		setDevices([]);
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		await micPromise;

		expect(instances()[0]?.opts.sampleRate).toBe(48000);
	});

	it("falls through the rate list on async error and resolves once one succeeds", async () => {
		setDevices([]);
		const micPromise = createMic();

		(await waitForInstance(0)).emit(
			"error",
			new Error("The requested stream configuration is not supported by the device."),
		);
		(await waitForInstance(1)).emit("error", new Error("device refused"));
		(await waitForInstance(2)).emit("data", Buffer.alloc(2));

		await expect(micPromise).resolves.toBeDefined();
		expect(instances().map((i) => i.opts.sampleRate)).toEqual([48000, 44100, 96000]);
	});

	it("rejects with the underlying message + attempted rate when all rates fail", async () => {
		setDevices([]);
		const micPromise = createMic();

		(await waitForInstance(0)).emit(
			"error",
			new Error("The requested stream configuration is not supported by the device."),
		);
		(await waitForInstance(1)).emit("error", new Error("device refused"));
		(await waitForInstance(2)).emit("error", new Error("device refused"));

		await expect(micPromise).rejects.toThrow(/mic open failed at 96000 Hz/);
	});
});

describe("createMic — startup race plugs the silent-failure hole", () => {
	it("rejects (not silently resolves) when decibri emits an async error after construction", async () => {
		const micPromise = createMic();

		// Reject every fallback rate so the outer promise surfaces a rejection.
		(await waitForInstance(0)).emit(
			"error",
			new Error("Failed to open audio stream: The requested stream configuration is not supported by the device."),
		);
		(await waitForInstance(1)).emit("error", new Error("device refused"));
		(await waitForInstance(2)).emit("error", new Error("device refused"));

		await expect(micPromise).rejects.toThrow(/mic open failed at/);
	});

	it("resolves optimistically if neither data nor error arrives before the startup timeout", async () => {
		const micPromise = createMic();
		await waitForInstance(0);
		// No data, no error — just let the startup timer fire.
		await vi.advanceTimersByTimeAsync(2000);
		await expect(micPromise).resolves.toBeDefined();
	});
});

describe("createMic — adapter surface", () => {
	it("returned object exposes the DecibriLike surface", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		const mic = await micPromise;
		expect(typeof mic.on).toBe("function");
		expect(typeof mic.once).toBe("function");
		expect(typeof mic.stop).toBe("function");
	});

	it("queues data emitted before the consumer attaches a listener, then drains on first attach", async () => {
		const micPromise = createMic();
		const raw = await waitForInstance(0);
		// Priming chunk also settles the startup race.
		raw.emit("data", Buffer.alloc(2));
		const mic = await micPromise;

		// More chunks before any consumer subscribes.
		const chunkA = makeInt16Chunk(4800, 5000);
		const chunkB = makeInt16Chunk(4800, -5000);
		raw.emit("data", chunkA);
		raw.emit("data", chunkB);

		const seen: Buffer[] = [];
		mic.on("data", (b) => seen.push(b));

		// Drain runs on a microtask.
		await flush();
		await flush();

		// All chunks resampled and delivered (the 1-sample priming chunk is
		// too small to produce output after the resampler primes, so we
		// expect ≥ 2 from chunks A and B).
		expect(seen.length).toBeGreaterThanOrEqual(2);
		const lastResampled = seen[seen.length - 1]!;
		expect(lastResampled.length).toBeGreaterThan(0);
		// Forwarded chunks should be at 16 kHz scale — roughly a third of
		// the 4800-sample source chunks.
		expect(lastResampled.length).toBeLessThan(chunkB.length);
	});

	it("forwards stop() to the underlying decibri", async () => {
		const micPromise = createMic();
		(await waitForInstance(0)).emit("data", Buffer.alloc(2));
		const mic = await micPromise;
		mic.stop();
		expect(instances()[0]?.stop).toHaveBeenCalled();
	});

	it("exports stable 16 kHz target constants the pipeline depends on", () => {
		expect(TARGET_SAMPLE_RATE).toBe(16000);
		expect(FRAMES_PER_BUFFER).toBe(1600);
	});
});

// Drain microtasks until an expected instance shows up. `createMic` does
// `await import("decibri")` before constructing — the dynamic-import
// resolution chain takes a handful of microtasks, so a fixed N-tick
// `flush()` is racy. Poll instead, with a cap so a real failure surfaces.
async function waitForInstance(idx = 0): Promise<MockMicInstance> {
	for (let i = 0; i < 200; i++) {
		if (instances()[idx]) return instances()[idx]!;
		await Promise.resolve();
	}
	throw new Error(`MockMic instance #${idx} was never constructed`);
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeInt16Chunk(sampleCount: number, value: number): Buffer {
	const buf = Buffer.alloc(sampleCount * 2);
	for (let i = 0; i < sampleCount; i++) buf.writeInt16LE(value, i * 2);
	return buf;
}
