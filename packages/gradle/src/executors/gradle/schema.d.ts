export interface GradleExecutorSchema {
  taskName: string;
  testName?: string;
  args?: string[] | string;
  excludeDependsOn: boolean;
}
