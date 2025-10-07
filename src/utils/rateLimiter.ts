interface RateLimiterOptions {
	readonly maxCalls: number;
	readonly windowMs: number;
}

interface PendingTask {
	readonly run: () => Promise<void>;
}

export class RateLimiter {
	private readonly queue: PendingTask[] = [];
	private timestamps: number[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly options: RateLimiterOptions) {}

	schedule<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				run: () => fn().then(resolve, reject),
			});
			this.processQueue();
		});
	}

	private processQueue(): void {
		if (this.queue.length === 0) {
			return;
		}

		const now = Date.now();
		this.timestamps = this.timestamps.filter((timestamp) => now - timestamp < this.options.windowMs);

		if (this.timestamps.length >= this.options.maxCalls) {
			if (this.timer) {
				return;
			}
			const earliest = this.timestamps[0];
			const delay = Math.max(0, this.options.windowMs - (now - earliest));
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.processQueue();
			}, delay);
			return;
		}

		const task = this.queue.shift();
		if (!task) {
			return;
		}

		this.timestamps.push(now);
		Promise.resolve()
			.then(() => task.run())
			.finally(() => {
				this.processQueue();
			});
	}
}
