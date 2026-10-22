/** The trace schema, compiled when building (traceValidators in vite.shared.ts). */
declare module "virtual:trace-validators" {
  interface ValidationError {
    instancePath: string;
    keyword: string;
    params: Record<string, unknown>;
    message?: string;
  }
  interface Validator {
    (data: unknown): boolean;
    errors?: ValidationError[] | null;
  }
  /** The whole trace, with each step's heap objects checked only as objects. */
  export const shell: Validator;
  /** One heap object, in full. */
  export const heapObject: Validator;
}
