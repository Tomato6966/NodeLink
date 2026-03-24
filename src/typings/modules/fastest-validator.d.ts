/**
 * Type declarations for fastest-validator
 * @module fastest-validator
 */

declare module 'fastest-validator' {
  export type ValidationResult =
    | true
    | Array<{ message: string; type: string; field: string }>

  export interface ValidationRule {
    type: string
    empty?: boolean
    min?: number
    max?: number
    optional?: boolean
    nullable?: boolean
    default?: unknown
    messages?: Record<string, string>

    [key: string]: unknown
  }

  export interface ValidationSchema {
    [key: string]: ValidationRule | unknown
  }

  export interface ValidatorOptions {
    haltOnFirstError?: boolean
    useNewCustomCheckerFunction?: boolean

    [key: string]: unknown
  }

  export type CompiledValidator = (data: unknown) => ValidationResult

  export default class Validator {
    constructor(options?: ValidatorOptions)
    compile(schema: ValidationSchema): CompiledValidator
    validate(data: unknown, schema: ValidationSchema): ValidationResult
  }
}
