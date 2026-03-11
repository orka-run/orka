export interface RunnerSession {
  name: string;
  created: number;
  attached: boolean;
  width: number;
  height: number;
}

export interface SessionRunner {
  spawn(name: string, scriptPath: string, cwd: string): Promise<void>;
  kill(name: string): Promise<void>;
  has(name: string): Promise<boolean>;
  list(): Promise<RunnerSession[]>;
  capture(name: string, lines?: number): Promise<string>;
  sendKeys(name: string, keys: string): Promise<void>;
  sendText(name: string, text: string): Promise<void>;
  attach(name: string): Promise<void>;
}
