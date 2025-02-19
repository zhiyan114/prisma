import { setClassName } from '@prisma/internals'
import Decimal from 'decimal.js'
import indent from 'indent-string'
import { bold, dim, green, red, white } from 'kleur/colors'
import stripAnsi from 'strip-ansi'

import { MergedExtensionsList } from './core/extensions/MergedExtensionsList'
import { applyComputedFieldsToSelection } from './core/extensions/resultUtils'
import { FieldRefImpl } from './core/model/FieldRef'
import type { /*dmmf, */ DMMFHelper } from './dmmf'
import type { DMMF } from './dmmf-types'
import type {
  ArgError,
  AtLeastOneError,
  AtMostOneError,
  FieldError,
  InvalidArgError,
  InvalidFieldError,
} from './error-types'
import { ObjectEnumValue } from './object-enums'
import { CallSite } from './utils/CallSite'
import {
  getGraphQLType,
  getInputTypeName,
  getOutputTypeName,
  getSuggestion,
  inputTypeToJson,
  isGroupByOutputName,
  stringifyGraphQLType,
  stringifyInputType,
  unionBy,
  wrapWithList,
} from './utils/common'
import { createErrorMessageWithContext } from './utils/createErrorMessageWithContext'
import { isDate, isValidDate } from './utils/date'
import { isDecimalJsLike } from './utils/decimalJsLike'
import { deepExtend } from './utils/deep-extend'
import { deepGet } from './utils/deep-set'
import { filterObject } from './utils/filterObject'
import { isObject } from './utils/isObject'
import { omit } from './utils/omit'
import type { MissingItem, PrintJsonWithErrorsArgs } from './utils/printJsonErrors'
import { printJsonWithErrors } from './utils/printJsonErrors'
import stringifyObject from './utils/stringifyObject'

const tab = 2

type MakeDocumentContext = {
  modelName?: string
}

export class Document {
  constructor(public readonly type: 'query' | 'mutation', public readonly children: Field[]) {
    this.type = type
    this.children = children
  }
  get [Symbol.toStringTag]() {
    return 'Document'
  }
  public toString() {
    return `${this.type} {
${indent(this.children.map(String).join('\n'), tab)}
}`
  }
  public validate(
    select?: any,
    isTopLevelQuery = false,
    originalMethod?: string,
    errorFormat?: 'pretty' | 'minimal' | 'colorless',
    validationCallsite?: any,
  ) {
    if (!select) {
      select = {}
    }
    const invalidChildren = this.children.filter((child) => child.hasInvalidChild || child.hasInvalidArg)
    if (invalidChildren.length === 0) {
      return
    }

    const fieldErrors: FieldError[] = []
    const argErrors: ArgError[] = []
    const prefix = select && select.select ? 'select' : select.include ? 'include' : undefined

    for (const child of invalidChildren) {
      const errors = child.collectErrors(prefix)
      fieldErrors.push(
        ...errors.fieldErrors.map((e) => ({
          ...e,
          path: isTopLevelQuery ? e.path : e.path.slice(1),
        })),
      )
      argErrors.push(
        ...errors.argErrors.map((e) => ({
          ...e,
          path: isTopLevelQuery ? e.path : e.path.slice(1),
        })),
      )
    }

    const topLevelQueryName = this.children[0].name
    const queryName = isTopLevelQuery ? this.type : topLevelQueryName
    const keyPaths: string[] = []
    const valuePaths: string[] = []
    const missingItems: MissingItem[] = []
    for (const fieldError of fieldErrors) {
      const path = this.normalizePath(fieldError.path, select).join('.')
      if (fieldError.error.type === 'invalidFieldName') {
        keyPaths.push(path)

        const fieldType = fieldError.error.outputType
        const { isInclude } = fieldError.error
        fieldType.fields
          .filter((field) => (isInclude ? field.outputType.location === 'outputObjectTypes' : true))
          .forEach((field) => {
            const splittedPath = path.split('.')
            missingItems.push({
              path: `${splittedPath.slice(0, splittedPath.length - 1).join('.')}.${field.name}`,
              type: 'true',
              isRequired: false,
            })
          })
      } else if (fieldError.error.type === 'includeAndSelect') {
        keyPaths.push('select')
        keyPaths.push('include')
      } else {
        valuePaths.push(path)
      }
      if (
        fieldError.error.type === 'emptySelect' ||
        fieldError.error.type === 'noTrueSelect' ||
        fieldError.error.type === 'emptyInclude'
      ) {
        const selectPathArray = this.normalizePath(fieldError.path, select)
        const selectPath = selectPathArray.slice(0, selectPathArray.length - 1).join('.')

        const fieldType = fieldError.error.field.outputType.type as DMMF.OutputType

        fieldType.fields
          ?.filter((field) =>
            fieldError.error.type === 'emptyInclude' ? field.outputType.location === 'outputObjectTypes' : true,
          )
          .forEach((field) => {
            missingItems.push({
              path: `${selectPath}.${field.name}`,
              type: 'true',
              isRequired: false,
            })
          })
      }
    }
    // an arg error can either be an invalid key or invalid value
    for (const argError of argErrors) {
      const path = this.normalizePath(argError.path, select).join('.')
      if (argError.error.type === 'invalidName') {
        keyPaths.push(path)
      } else if (argError.error.type !== 'missingArg' && argError.error.type !== 'atLeastOne') {
        valuePaths.push(path)
      } else if (argError.error.type === 'missingArg') {
        const type =
          argError.error.missingArg.inputTypes.length === 1
            ? argError.error.missingArg.inputTypes[0].type
            : argError.error.missingArg.inputTypes
                .map((t) => {
                  const inputTypeName = getInputTypeName(t.type)
                  if (inputTypeName === 'Null') {
                    return 'null'
                  }
                  if (t.isList) {
                    return inputTypeName + '[]'
                  }
                  return inputTypeName
                })
                .join(' | ')
        missingItems.push({
          path,
          type: inputTypeToJson(type, true, path.split('where.').length === 2),
          isRequired: argError.error.missingArg.isRequired,
        })
      }
    }

    const renderErrorStr = (callsite?: CallSite) => {
      const hasRequiredMissingArgsErrors = argErrors.some(
        (e) => e.error.type === 'missingArg' && e.error.missingArg.isRequired,
      )
      const hasOptionalMissingArgsErrors = Boolean(
        argErrors.find((e) => e.error.type === 'missingArg' && !e.error.missingArg.isRequired),
      )
      const hasMissingArgsErrors = hasOptionalMissingArgsErrors || hasRequiredMissingArgsErrors

      let missingArgsLegend = ''
      if (hasRequiredMissingArgsErrors) {
        missingArgsLegend += `\n${dim('Note: Lines with ')}${green('+')} ${dim('are required')}`
      }

      if (hasOptionalMissingArgsErrors) {
        if (missingArgsLegend.length === 0) {
          missingArgsLegend = '\n'
        }
        if (hasRequiredMissingArgsErrors) {
          missingArgsLegend += dim(`, lines with ${green('?')} are optional`)
        } else {
          missingArgsLegend += dim(`Note: Lines with ${green('?')} are optional`)
        }
        missingArgsLegend += dim('.')
      }

      const relevantArgErrors = argErrors.filter((e) => e.error.type !== 'missingArg' || e.error.missingArg.isRequired)

      let errorMessages = relevantArgErrors
        .map((e) => this.printArgError(e, hasMissingArgsErrors, errorFormat === 'minimal')) // if no callsite is provided, just render the minimal error
        .join('\n')

      errorMessages += `
${fieldErrors.map((e) => this.printFieldError(e, missingItems, errorFormat === 'minimal')).join('\n')}`

      if (errorFormat === 'minimal') {
        return stripAnsi(errorMessages)
      }

      let printJsonArgs: PrintJsonWithErrorsArgs = {
        ast: isTopLevelQuery ? { [topLevelQueryName]: select } : select,
        keyPaths,
        valuePaths,
        missingItems,
      }

      // as for aggregate we simplify the api to not include `select`
      // we need to map this here so the errors make sense
      if (originalMethod?.endsWith('aggregate')) {
        printJsonArgs = transformAggregatePrintJsonArgs(printJsonArgs)
      }

      const errorStr = createErrorMessageWithContext({
        callsite,
        originalMethod: originalMethod || queryName,
        showColors: errorFormat && errorFormat === 'pretty',
        callArguments: printJsonWithErrors(printJsonArgs),
        message: `${errorMessages}${missingArgsLegend}\n`,
      })

      if (process.env.NO_COLOR || errorFormat === 'colorless') {
        return stripAnsi(errorStr)
      }
      return errorStr
    }
    // end renderErrorStr definition

    const error = new PrismaClientValidationError(renderErrorStr(validationCallsite))

    if (process.env.NODE_ENV !== 'production') {
      Object.defineProperty(error, 'render', {
        get: () => renderErrorStr,
        enumerable: false,
      })
    }
    throw error
  }
  protected printFieldError = ({ error }: FieldError, missingItems: MissingItem[], minimal: boolean) => {
    if (error.type === 'emptySelect') {
      const additional = minimal ? '' : ` Available options are listed in ${dim(green('green'))}.`
      return `The ${red('`select`')} statement for type ${bold(
        getOutputTypeName(error.field.outputType.type),
      )} must not be empty.${additional}`
    }
    if (error.type === 'emptyInclude') {
      if (missingItems.length === 0) {
        return `${bold(
          getOutputTypeName(error.field.outputType.type),
        )} does not have any relation and therefore can't have an ${red('`include`')} statement.`
      }
      const additional = minimal ? '' : ` Available options are listed in ${dim(green('green'))}.`
      return `The ${red('`include`')} statement for type ${red(
        getOutputTypeName(error.field.outputType.type),
      )} must not be empty.${additional}`
    }
    if (error.type === 'noTrueSelect') {
      return `The ${red('`select`')} statement for type ${red(
        getOutputTypeName(error.field.outputType.type),
      )} needs ${red('at least one truthy value')}.`
    }
    if (error.type === 'includeAndSelect') {
      return `Please ${bold('either')} use ${green('`include`')} or ${green('`select`')}, but ${red(
        'not both',
      )} at the same time.`
    }
    if (error.type === 'invalidFieldName') {
      const statement = error.isInclude ? 'include' : 'select'
      const wording = error.isIncludeScalar ? 'Invalid scalar' : 'Unknown'
      const additional = minimal
        ? ''
        : error.isInclude && missingItems.length === 0
        ? `\nThis model has no relations, so you can't use ${red('include')} with it.`
        : ` Available options are listed in ${dim(green('green'))}.`
      let str = `${wording} field ${red(`\`${error.providedName}\``)} for ${red(statement)} statement on model ${bold(
        white(error.modelName),
      )}.${additional}`

      if (error.didYouMean) {
        str += ` Did you mean ${green(`\`${error.didYouMean}\``)}?`
      }

      if (error.isIncludeScalar) {
        str += `\nNote, that ${bold('include')} statements only accept relation fields.`
      }

      return str
    }
    if (error.type === 'invalidFieldType') {
      const str = `Invalid value ${red(`${stringifyObject(error.providedValue)}`)} of type ${red(
        getGraphQLType(error.providedValue, undefined),
      )} for field ${bold(`${error.fieldName}`)} on model ${bold(white(error.modelName))}. Expected either ${green(
        'true',
      )} or ${green('false')}.`

      return str
    }

    return undefined
  }

  protected printArgError = ({ error, path }: ArgError, hasMissingItems: boolean, minimal: boolean) => {
    if (error.type === 'invalidName') {
      let str = `Unknown arg ${red(`\`${error.providedName}\``)} in ${bold(path.join('.'))} for type ${bold(
        error.outputType ? error.outputType.name : getInputTypeName(error.originalType),
      )}.`
      if (error.didYouMeanField) {
        str += `\n→ Did you forget to wrap it with \`${green('select')}\`? ${dim(
          'e.g. ' + green(`{ select: { ${error.providedName}: ${error.providedValue} } }`),
        )}`
      } else if (error.didYouMeanArg) {
        str += ` Did you mean \`${green(error.didYouMeanArg)}\`?`
        if (!hasMissingItems && !minimal) {
          str += ` ${dim('Available args:')}\n` + stringifyInputType(error.originalType, true)
        }
      } else {
        if ((error.originalType as DMMF.InputType).fields.length === 0) {
          str += ` The field ${bold((error.originalType as DMMF.InputType).name)} has no arguments.`
        } else if (!hasMissingItems && !minimal) {
          str += ` Available args:\n\n` + stringifyInputType(error.originalType, true)
        }
      }
      return str
    }

    if (error.type === 'invalidType') {
      let valueStr = stringifyObject(error.providedValue, { indent: '  ' })
      const multilineValue = valueStr.split('\n').length > 1
      if (multilineValue) {
        valueStr = `\n${valueStr}\n`
      }
      // TODO: we don't yet support enums in a union with a non enum. This is mostly due to not implemented error handling
      // at this code part.
      if (error.requiredType.bestFittingType.location === 'enumTypes') {
        return `Argument ${bold(error.argName)}: Provided value ${red(valueStr)}${
          multilineValue ? '' : ' '
        }of type ${red(getGraphQLType(error.providedValue))} on ${bold(
          `prisma.${this.children[0].name}`,
        )} is not a ${green(
          wrapWithList(
            stringifyGraphQLType(error.requiredType.bestFittingType.type),
            error.requiredType.bestFittingType.isList,
          ),
        )}.
→ Possible values: ${(error.requiredType.bestFittingType.type as DMMF.SchemaEnum).values
          .map((v) => green(`${stringifyGraphQLType(error.requiredType.bestFittingType.type)}.${v}`))
          .join(', ')}`
      }

      let typeStr = '.'
      if (isInputArgType(error.requiredType.bestFittingType.type)) {
        typeStr = ':\n' + stringifyInputType(error.requiredType.bestFittingType.type)
      }
      let expected = `${error.requiredType.inputType
        .map((t) => green(wrapWithList(stringifyGraphQLType(t.type), error.requiredType.bestFittingType.isList)))
        .join(' or ')}${typeStr}`
      const inputType: null | DMMF.SchemaArgInputType =
        (error.requiredType.inputType.length === 2 &&
          error.requiredType.inputType.find((t) => isInputArgType(t.type))) ||
        null
      if (inputType) {
        expected += `\n` + stringifyInputType(inputType.type, true)
      }
      return `Argument ${bold(error.argName)}: Got invalid value ${red(valueStr)}${multilineValue ? '' : ' '}on ${bold(
        `prisma.${this.children[0].name}`,
      )}. Provided ${red(getGraphQLType(error.providedValue))}, expected ${expected}`
    }

    if (error.type === 'invalidNullArg') {
      const forStr = path.length === 1 && path[0] === error.name ? '' : ` for ${bold(`${path.join('.')}`)}`
      const undefinedTip = ` Please use ${bold(green('undefined'))} instead.`
      return `Argument ${green(error.name)}${forStr} must not be ${bold('null')}.${undefinedTip}`
    }

    if (error.type === 'invalidDateArg') {
      const forStr = path.length === 1 && path[0] === error.argName ? '' : ` for ${bold(`${path.join('.')}`)}`
      return `Argument ${green(error.argName)}${forStr} is not a valid Date object.`
    }

    if (error.type === 'missingArg') {
      const forStr = path.length === 1 && path[0] === error.missingName ? '' : ` for ${bold(`${path.join('.')}`)}`
      return `Argument ${green(error.missingName)}${forStr} is missing.`
    }

    if (error.type === 'atLeastOne') {
      const additional = minimal ? '' : ` Available args are listed in ${dim(green('green'))}.`
      const atLeastFieldsError = error.atLeastFields
        ? ` and at least one argument for ${error.atLeastFields.map((field) => bold(field)).join(', or ')}`
        : ''
      return `Argument ${bold(path.join('.'))} of type ${bold(error.inputType.name)} needs ${green(
        'at least one',
      )} argument${bold(atLeastFieldsError)}.${additional}`
    }

    if (error.type === 'atMostOne') {
      const additional = minimal
        ? ''
        : ` Please choose one. ${dim('Available args:')} \n${stringifyInputType(error.inputType, true)}`
      return `Argument ${bold(path.join('.'))} of type ${bold(error.inputType.name)} needs ${green(
        'exactly one',
      )} argument, but you provided ${error.providedKeys.map((key) => red(key)).join(' and ')}.${additional}`
    }

    return undefined
  }
  /**
   * As we're allowing both single objects and array of objects for list inputs, we need to remove incorrect
   * zero indexes from the path
   * @param inputPath e.g. ['where', 'AND', 0, 'id']
   * @param select select object
   */
  private normalizePath(inputPath: Array<string | number>, select: any) {
    const path = inputPath.slice()
    const newPath: Array<string | number> = []
    let key: undefined | string | number
    let pointer = select
    while ((key = path.shift()) !== undefined) {
      if (!Array.isArray(pointer) && key === 0) {
        continue
      }
      if (key === 'select') {
        // TODO: Remove this logic! It shouldn't be needed
        if (!pointer[key]) {
          pointer = pointer.include
        } else {
          pointer = pointer[key]
        }
      } else if (pointer && pointer[key]) {
        pointer = pointer[key]
      }

      newPath.push(key)
    }
    return newPath
  }
}

export class PrismaClientValidationError extends Error {
  get [Symbol.toStringTag]() {
    return 'PrismaClientValidationError'
  }
}
setClassName(PrismaClientValidationError, 'PrismaClientValidationError')
export class PrismaClientConstructorValidationError extends Error {
  constructor(message: string) {
    super(message + `\nRead more at https://pris.ly/d/client-constructor`)
    this.name = 'PrismaClientConstructorValidationError'
  }
  get [Symbol.toStringTag]() {
    return 'PrismaClientConstructorValidationError'
  }
}
setClassName(PrismaClientConstructorValidationError, 'PrismaClientConstructorValidationError')

export interface FieldArgs {
  name: string
  schemaField?: DMMF.SchemaField // optional as we want to even build up invalid queries to collect all errors
  args?: Args
  children?: Field[]
  error?: InvalidFieldError
}

export class Field {
  public readonly name: string
  public readonly args?: Args
  public readonly children?: Field[]
  public readonly error?: InvalidFieldError
  public readonly hasInvalidChild: boolean
  public readonly hasInvalidArg: boolean
  public readonly schemaField?: DMMF.SchemaField
  constructor({ name, args, children, error, schemaField }: FieldArgs) {
    this.name = name
    this.args = args
    this.children = children
    this.error = error
    this.schemaField = schemaField
    this.hasInvalidChild = children
      ? children.some((child) => Boolean(child.error || child.hasInvalidArg || child.hasInvalidChild))
      : false
    this.hasInvalidArg = args ? args.hasInvalidArg : false
  }
  get [Symbol.toStringTag]() {
    return 'Field'
  }
  public toString() {
    let str = this.name

    if (this.error) {
      return str + ' # INVALID_FIELD'
    }

    if (this.args && this.args.args && this.args.args.length > 0) {
      if (this.args.args.length === 1) {
        str += `(${this.args.toString()})`
      } else {
        str += `(\n${indent(this.args.toString(), tab)}\n)`
      }
    }

    if (this.children) {
      str += ` {
${indent(this.children.map(String).join('\n'), tab)}
}`
    }

    return str
  }
  public collectErrors(prefix = 'select'): {
    fieldErrors: FieldError[]
    argErrors: ArgError[]
  } {
    const fieldErrors: FieldError[] = []
    const argErrors: ArgError[] = []

    if (this.error) {
      fieldErrors.push({
        path: [this.name],
        error: this.error,
      })
    }

    // get all errors from fields
    if (this.children) {
      for (const child of this.children) {
        const errors = child.collectErrors(prefix)
        // Field -> Field always goes through a 'select'
        fieldErrors.push(
          ...errors.fieldErrors.map((e) => ({
            ...e,
            path: [this.name, prefix, ...e.path],
          })),
        )
        argErrors.push(
          ...errors.argErrors.map((e) => ({
            ...e,
            path: [this.name, prefix, ...e.path],
          })),
        )
      }
    }

    // get all errors from args
    if (this.args) {
      argErrors.push(...this.args.collectErrors().map((e) => ({ ...e, path: [this.name, ...e.path] })))
    }

    return {
      fieldErrors,
      argErrors,
    }
  }
}

export class Args {
  public args: Arg[]
  public readonly hasInvalidArg: boolean
  constructor(args: Arg[] = []) {
    this.args = args
    this.hasInvalidArg = args ? args.some((arg) => Boolean(arg.hasError)) : false
  }
  get [Symbol.toStringTag]() {
    return 'Args'
  }
  public toString() {
    if (this.args.length === 0) {
      return ''
    }
    return `${this.args
      .map((arg) => arg.toString())
      .filter((a) => a)
      .join('\n')}`
  }
  public collectErrors(): ArgError[] {
    if (!this.hasInvalidArg) {
      return []
    }

    return this.args.flatMap((arg) => arg.collectErrors())
  }
}

/**
 * Custom stringify which turns undefined into null - needed by GraphQL
 * @param value to stringify
 * @param _
 * @param tab
 */
function stringify(value: any, inputType?: DMMF.SchemaArgInputType) {
  if (Buffer.isBuffer(value)) {
    return JSON.stringify(value.toString('base64'))
  }

  if (value instanceof FieldRefImpl) {
    return `{ _ref: ${JSON.stringify(value.name)}}`
  }

  if (Object.prototype.toString.call(value) === '[object BigInt]') {
    return value.toString()
  }

  if (typeof inputType?.type === 'string' && inputType.type === 'Json') {
    if (value === null) {
      return 'null'
    }
    if (value && value.values && value.__prismaRawParameters__) {
      return JSON.stringify(value.values)
    }
    if (inputType?.isList && Array.isArray(value)) {
      return JSON.stringify(value.map((o) => JSON.stringify(o)))
    }
    // because we send json as a string
    return JSON.stringify(JSON.stringify(value))
  }

  if (value === undefined) {
    // TODO: This is a bit weird. can't we unify this with the === null case?
    return null
  }

  if (value === null) {
    return 'null'
  }

  if (Decimal.isDecimal(value) || (inputType?.type === 'Decimal' && isDecimalJsLike(value))) {
    return JSON.stringify(value.toFixed())
  }

  if (inputType?.location === 'enumTypes' && typeof value === 'string') {
    if (Array.isArray(value)) {
      return `[${value.join(', ')}]`
    }
    return value
  }

  if (typeof value === 'number' && inputType?.type === 'Float') {
    return value.toExponential()
  }

  return JSON.stringify(value, null, 2)
}

interface ArgOptions {
  key: string
  value: ArgValue
  isEnum?: boolean
  error?: InvalidArgError
  schemaArg?: DMMF.SchemaArg
  inputType?: DMMF.SchemaArgInputType
}

export class Arg {
  public key: string
  // not readonly, as we later need to transform it
  public value: ArgValue
  public error?: InvalidArgError
  public hasError: boolean
  public isEnum: boolean
  public schemaArg?: DMMF.SchemaArg
  public isNullable: boolean
  public inputType?: DMMF.SchemaArgInputType

  constructor({ key, value, isEnum = false, error, schemaArg, inputType }: ArgOptions) {
    this.inputType = inputType
    this.key = key
    this.value = value instanceof ObjectEnumValue ? value._getName() : value
    this.isEnum = isEnum
    this.error = error
    this.schemaArg = schemaArg
    this.isNullable =
      schemaArg?.inputTypes.reduce<boolean>((isNullable) => isNullable && schemaArg.isNullable, true) || false
    this.hasError =
      Boolean(error) ||
      (value instanceof Args ? value.hasInvalidArg : false) ||
      (Array.isArray(value) &&
        value.some((v) => {
          if (v instanceof Args) {
            return v.hasInvalidArg
          }
          if (v instanceof Arg) {
            return v.hasError
          }
          return false
        }))
  }
  get [Symbol.toStringTag]() {
    return 'Arg'
  }
  public _toString(value: ArgValue, key: string): string | undefined {
    const strValue = this.stringifyValue(value)
    if (typeof strValue === 'undefined') {
      return undefined
    }

    return `${key}: ${strValue}`
  }

  public stringifyValue(value: ArgValue) {
    if (typeof value === 'undefined') {
      return undefined
    }
    if (value instanceof Args) {
      return `{
${indent(value.toString(), 2)}
}`
    }

    if (Array.isArray(value)) {
      if (this.inputType?.type === 'Json') {
        return stringify(value, this.inputType)
      }

      const isScalar = !(value as any[]).some((v) => typeof v === 'object')
      return `[${isScalar ? '' : '\n'}${indent(
        (value as any[])
          .map((nestedValue) => {
            if (nestedValue instanceof Args) {
              // array element is an object - stringify it, wrapping in {}
              return `{\n${indent(nestedValue.toString(), tab)}\n}`
            }
            if (nestedValue instanceof Arg) {
              // array element is scalar value, wrapped in Arg (for example, for error reporting purposes)
              // Stringify just the value, ignoring the key
              return nestedValue.stringifyValue(nestedValue.value)
            }

            // array element is a plain scalar value
            return stringify(nestedValue, this.inputType)
          })
          .join(`,${isScalar ? ' ' : '\n'}`),
        isScalar ? 0 : tab,
      )}${isScalar ? '' : '\n'}]`
    }

    return stringify(value, this.inputType)
  }

  public toString() {
    return this._toString(this.value, this.key)
  }
  // TODO: memoize this function
  public collectErrors(): ArgError[] {
    if (!this.hasError) {
      return []
    }

    const errors: ArgError[] = []

    // add the own arg
    if (this.error) {
      const id =
        typeof this.inputType?.type === 'object'
          ? `${this.inputType.type.name}${this.inputType.isList ? '[]' : ''}`
          : undefined
      errors.push({
        error: this.error,
        path: [this.key],
        id,
      })
    }

    if (Array.isArray(this.value)) {
      return errors.concat(
        (this.value as any[]).flatMap((val, index) => {
          if (val instanceof Args) {
            // array element is in object
            return val.collectErrors().map((e) => {
              // append parent path and index to a nested error path
              return { ...e, path: [this.key, String(index), ...e.path] }
            })
          }

          if (val instanceof Arg) {
            // value is not an object and has errors attached to it
            return val.collectErrors().map((e) => {
              // append parent path to the error. index is already a part of e.path
              return { ...e, path: [this.key, ...e.path] }
            })
          }

          // scalar value that has no errors attached
          return []
        }),
      )
    }

    // collect errors of children if there are any
    if (this.value instanceof Args) {
      return errors.concat(this.value.collectErrors().map((e) => ({ ...e, path: [this.key, ...e.path] })))
    }

    return errors
  }
}

export type ArgValue =
  | string
  | boolean
  | number
  | undefined
  | Args
  | string[]
  | boolean[]
  | number[]
  | Args[]
  | Date
  | null

export interface DocumentInput {
  dmmf: DMMFHelper
  rootTypeName: 'query' | 'mutation'
  rootField: string
  select?: any
  modelName?: string
  extensions: MergedExtensionsList
}

export function makeDocument({
  dmmf,
  rootTypeName,
  rootField,
  select,
  modelName,
  extensions,
}: DocumentInput): Document {
  if (!select) {
    select = {}
  }
  const rootType = rootTypeName === 'query' ? dmmf.queryType : dmmf.mutationType
  // Create a fake toplevel field for easier implementation
  const fakeRootField: DMMF.SchemaField = {
    args: [],
    outputType: {
      isList: false,
      type: rootType,
      location: 'outputObjectTypes',
    },
    name: rootTypeName,
  }
  const context = {
    modelName,
  }
  const children = selectionToFields({
    dmmf,
    selection: { [rootField]: select },
    schemaField: fakeRootField,
    path: [rootTypeName],
    context,
    extensions,
  })
  return new Document(rootTypeName, children) as any
}

// TODO: get rid of this function
export function transformDocument(document: Document): Document {
  return document
}

type SelectionToFieldsArgs = {
  dmmf: DMMFHelper
  selection: any
  schemaField: DMMF.SchemaField
  path: string[]
  context: MakeDocumentContext
  extensions: MergedExtensionsList
}

export function selectionToFields({
  dmmf,
  selection,
  schemaField,
  path,
  context,
  extensions,
}: SelectionToFieldsArgs): Field[] {
  const outputType = schemaField.outputType.type as DMMF.OutputType
  const computedFields = context.modelName ? extensions.getAllComputedFields(context.modelName) : {}
  selection = applyComputedFieldsToSelection(selection, computedFields)
  return Object.entries(selection).reduce((acc, [name, value]: any) => {
    const field = outputType.fieldMap ? outputType.fieldMap[name] : outputType.fields.find((f) => f.name === name)

    if (!field) {
      if (computedFields?.[name]) {
        return acc
      }
      // if the field name is incorrect, we ignore the args and child fields altogether
      acc.push(
        new Field({
          name,
          children: [],
          error: {
            type: 'invalidFieldName',
            modelName: outputType.name,
            providedName: name,
            didYouMean: getSuggestion(
              name,
              outputType.fields.map((f) => f.name).concat(Object.keys(computedFields ?? {})),
            ),
            outputType,
          },
        }),
      )

      return acc
    }

    if (field.outputType.location === 'scalar' && field.args.length === 0 && typeof value !== 'boolean') {
      acc.push(
        new Field({
          name,
          children: [],
          error: {
            type: 'invalidFieldType',
            modelName: outputType.name,
            fieldName: name,
            providedValue: value,
          },
        }),
      )

      return acc
    }
    if (value === false) {
      return acc
    }

    const transformedField = {
      name: field.name,
      fields: field.args,
      constraints: {
        minNumFields: null,
        maxNumFields: null,
      },
    }
    const argsWithoutIncludeAndSelect = typeof value === 'object' ? omit(value, ['include', 'select']) : undefined
    const args = argsWithoutIncludeAndSelect
      ? objectToArgs(
          argsWithoutIncludeAndSelect,
          transformedField,
          context,
          [],
          typeof field === 'string' ? undefined : (field.outputType.type as DMMF.OutputType),
        )
      : undefined
    const isRelation = field.outputType.location === 'outputObjectTypes'

    // TODO: use default selection for `include` again

    // check for empty select
    if (value) {
      if (value.select && value.include) {
        acc.push(
          new Field({
            name,
            children: [
              new Field({
                name: 'include',
                args: new Args(),
                error: {
                  type: 'includeAndSelect',
                  field,
                },
              }),
            ],
          }),
        )
      } else if (value.include) {
        const keys = Object.keys(value.include)

        if (keys.length === 0) {
          acc.push(
            new Field({
              name,
              children: [
                new Field({
                  name: 'include',
                  args: new Args(),
                  error: {
                    type: 'emptyInclude',
                    field,
                  },
                }),
              ],
            }),
          )

          return acc
        }

        // TODO: unify with select validation logic
        /**
         * Error handling for `include` statements
         */
        if (field.outputType.location === 'outputObjectTypes') {
          const fieldOutputType = field.outputType.type as DMMF.OutputType
          const allowedKeys = fieldOutputType.fields
            .filter((f) => f.outputType.location === 'outputObjectTypes')
            .map((f) => f.name)
          const invalidKeys = keys.filter((key) => !allowedKeys.includes(key))
          if (invalidKeys.length > 0) {
            acc.push(
              ...invalidKeys.map(
                (invalidKey) =>
                  new Field({
                    name: invalidKey,
                    children: [
                      new Field({
                        name: invalidKey,
                        args: new Args(),
                        error: {
                          type: 'invalidFieldName',
                          modelName: fieldOutputType.name,
                          outputType: fieldOutputType,
                          providedName: invalidKey,
                          didYouMean: getSuggestion(invalidKey, allowedKeys) || undefined,
                          isInclude: true,
                          isIncludeScalar: fieldOutputType.fields.some((f) => f.name === invalidKey),
                        },
                      }),
                    ],
                  }),
              ),
            )
            return acc
          }
        }
      } else if (value.select) {
        const values = Object.values(value.select)
        if (values.length === 0) {
          acc.push(
            new Field({
              name,
              children: [
                new Field({
                  name: 'select',
                  args: new Args(),
                  error: {
                    type: 'emptySelect',
                    field,
                  },
                }),
              ],
            }),
          )

          return acc
        }

        // check if there is at least one truthy value
        const truthyValues = values.filter((v) => v)
        if (truthyValues.length === 0) {
          acc.push(
            new Field({
              name,
              children: [
                new Field({
                  name: 'select',
                  args: new Args(),
                  error: {
                    type: 'noTrueSelect',
                    field,
                  },
                }),
              ],
            }),
          )

          return acc
        }
      }
    }
    // either use select or default selection, but not both at the same time
    const defaultSelection = isRelation ? getDefaultSelection(dmmf, field.outputType.type as DMMF.OutputType) : null

    let select = defaultSelection
    if (value) {
      if (value.select) {
        select = value.select
      } else if (value.include) {
        select = deepExtend(defaultSelection, value.include)
        /**
         * special case for group by:
         * The "by" is an array of fields like ["email", "name"]
         * We turn that into a select statement of that form:
         * {
         *   "email": true,
         *   "name": true,
         * }
         */
      } else if (
        value.by &&
        Array.isArray(value.by) &&
        field.outputType.namespace === 'prisma' &&
        field.outputType.location === 'outputObjectTypes' &&
        isGroupByOutputName((field.outputType.type as DMMF.OutputType).name)
      ) {
        select = byToSelect(value.by)
      }
    }

    let children: Field[] | undefined
    if (select !== false && isRelation) {
      let modelName = context.modelName
      if (
        typeof field.outputType.type === 'object' &&
        field.outputType.namespace === 'model' &&
        field.outputType.location === 'outputObjectTypes'
      ) {
        modelName = field.outputType.type.name
      }
      children = selectionToFields({
        dmmf,
        selection: select,
        schemaField: field,
        path: [...path, name],
        context: { modelName },
        extensions,
      })
    }

    acc.push(new Field({ name, args, children, schemaField: field }))

    return acc
  }, [] as Field[])
}

function byToSelect(by: string[]): Record<string, true> {
  const obj = Object.create(null)
  for (const b of by) {
    obj[b] = true
  }
  return obj
}

function getDefaultSelection(dmmf: DMMFHelper, outputType: DMMF.OutputType) {
  const acc = Object.create(null)

  for (const f of outputType.fields) {
    if (dmmf.typeMap[(f.outputType.type as DMMF.OutputType).name] !== undefined) {
      acc[f.name] = true // by default, we load composite fields
    }
    if (f.outputType.location === 'scalar' || f.outputType.location === 'enumTypes') {
      acc[f.name] = true // by default, we load all scalar fields
    }
  }

  return acc
}

function getInvalidTypeArg(
  key: string,
  value: any,
  arg: DMMF.SchemaArg,
  bestFittingType: DMMF.SchemaArgInputType,
): Arg {
  const arrg = new Arg({
    key,
    value,
    isEnum: bestFittingType.location === 'enumTypes',
    inputType: bestFittingType,
    error: {
      type: 'invalidType',
      providedValue: value,
      argName: key,
      requiredType: {
        inputType: arg.inputTypes,
        bestFittingType,
      },
    },
  })

  return arrg
}

// TODO: Refactor
function hasCorrectScalarType(value: any, inputType: DMMF.SchemaArgInputType, context: MakeDocumentContext): boolean {
  const { isList } = inputType
  const expectedType = getExpectedType(inputType, context)
  const graphQLType = getGraphQLType(value, inputType)

  if (graphQLType === expectedType) {
    return true
  }

  if (isList && graphQLType === 'List<>') {
    return true
  }

  if (
    expectedType === 'Json' &&
    graphQLType !== 'Symbol' &&
    !(value instanceof ObjectEnumValue) &&
    !(value instanceof FieldRefImpl)
  ) {
    return true
  }

  if (graphQLType === 'Int' && expectedType === 'BigInt') {
    return true
  }

  if ((graphQLType === 'Int' || graphQLType === 'Float') && expectedType === 'Decimal') {
    return true
  }

  // DateTime is a subset of string
  if (graphQLType === 'DateTime' && expectedType === 'String') {
    return true
  }

  // UUID is a subset of string
  if (graphQLType === 'UUID' && expectedType === 'String') {
    return true
  }

  if (graphQLType === 'String' && expectedType === 'ID') {
    return true
  }

  // Int is a subset of Float
  if (graphQLType === 'Int' && expectedType === 'Float') {
    return true
  }

  // Int is a subset of Long
  if (graphQLType === 'Int' && expectedType === 'Long') {
    return true
  }

  // to match all strings which are valid decimals
  if (graphQLType === 'String' && expectedType === 'Decimal' && isDecimalString(value)) {
    return true
  }

  if (value === null) {
    return true
  }

  if (inputType.isList && Array.isArray(value)) {
    // when it's a list, we check that all the conditions above are met within that list
    return value.every((v) => hasCorrectScalarType(v, { ...inputType, isList: false }, context))
  }

  return false
}

function getExpectedType(inputType: DMMF.SchemaArgInputType, context: MakeDocumentContext, isList = inputType.isList) {
  let type = stringifyGraphQLType(inputType.type)
  if (inputType.location === 'fieldRefTypes' && context.modelName) {
    type += `<${context.modelName}>`
  }
  return wrapWithList(type, isList)
}

const cleanObject = (obj) => filterObject(obj, (k, v) => v !== undefined)

function isDecimalString(value: string): boolean {
  // from https://github.com/MikeMcl/decimal.js/blob/master/decimal.js#L116
  return /^\-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(value)
}

function valueToArg(key: string, value: any, arg: DMMF.SchemaArg, context: MakeDocumentContext): Arg | null {
  /**
   * Go through the possible union input types.
   * Stop on the first successful one
   */
  let maybeArg: Arg | null = null

  const argsWithErrors: { arg: Arg; errors: ArgError[] }[] = []

  for (const inputType of arg.inputTypes) {
    maybeArg = tryInferArgs(key, value, arg, inputType, context)
    if (maybeArg?.collectErrors().length === 0) {
      return maybeArg
    }
    if (maybeArg && maybeArg?.collectErrors()) {
      const argErrors = maybeArg?.collectErrors()
      if (argErrors && argErrors.length > 0) {
        argsWithErrors.push({ arg: maybeArg, errors: argErrors })
      }
    }
  }

  if (maybeArg?.hasError && argsWithErrors.length > 0) {
    const argsWithScores = argsWithErrors.map(({ arg, errors }) => {
      const errorScores = errors.map((e) => {
        let score = 1

        if (e.error.type === 'invalidType') {
          // Math.exp is important here so a big depth is exponentially punished
          score = 2 * Math.exp(getDepth(e.error.providedValue)) + 1
        }

        score += Math.log(e.path.length)

        if (e.error.type === 'missingArg') {
          if (arg.inputType && isInputArgType(arg.inputType.type) && arg.inputType.type.name.includes('Unchecked')) {
            score *= 2
          }
        }

        if (e.error.type === 'invalidName') {
          if (isInputArgType(e.error.originalType)) {
            if (e.error.originalType.name.includes('Unchecked')) {
              score *= 2
            }
          }
        }

        // we use (1 / path.length) to make sure that this only makes a difference
        // in the cases, where the rest is the same
        return score
      })

      return {
        score: errors.length + sum(errorScores),
        arg,
        errors,
      }
    })

    argsWithScores.sort((a, b) => (a.score < b.score ? -1 : 1))

    return argsWithScores[0].arg
  }

  return maybeArg
}

function getDepth(object: any): number {
  let level = 1
  if (!object || typeof object !== 'object') {
    return level
  }
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      continue
    }

    if (typeof object[key] === 'object') {
      const depth = getDepth(object[key]) + 1
      level = Math.max(depth, level)
    }
  }
  return level
}

function sum(n: number[]): number {
  return n.reduce((acc, curr) => acc + curr, 0)
}

/**
 * Running through the possible input types of a union.
 * @param key
 * @param value
 * @param arg
 * @param inputType
 */
function tryInferArgs(
  key: string,
  value: any,
  arg: DMMF.SchemaArg,
  inputType: DMMF.SchemaArgInputType,
  context: MakeDocumentContext,
): Arg | null {
  if (typeof value === 'undefined') {
    // the arg is undefined and not required - we're fine
    if (!arg.isRequired) {
      return null
    }

    // the provided value is 'undefined' but shouldn't be
    return new Arg({
      key,
      value,
      isEnum: inputType.location === 'enumTypes',
      inputType,
      error: {
        type: 'missingArg',
        missingName: key,
        missingArg: arg,
        atLeastOne: false,
        atMostOne: false,
      },
    })
  }

  const { isNullable, isRequired } = arg

  if (value === null && !isNullable && !isRequired) {
    // we don't need to execute this ternary if not necessary
    const isAtLeastOne = isInputArgType(inputType.type)
      ? inputType.type.constraints.minNumFields !== null && inputType.type.constraints.minNumFields > 0
      : false
    if (!isAtLeastOne) {
      return new Arg({
        key,
        value,
        isEnum: inputType.location === 'enumTypes',
        inputType,
        error: {
          type: 'invalidNullArg',
          name: key,
          invalidType: arg.inputTypes,
          atLeastOne: false,
          atMostOne: false,
        },
      })
    }
  }

  // then the first
  if (!inputType.isList) {
    if (isInputArgType(inputType.type)) {
      if (
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (inputType.location === 'inputObjectTypes' && !isObject(value))
      ) {
        return getInvalidTypeArg(key, value, arg, inputType)
      } else {
        const val = cleanObject(value)
        let error: AtMostOneError | AtLeastOneError | undefined
        const keys = Object.keys(val || {})
        const numKeys = keys.length

        if (
          (numKeys === 0 &&
            typeof inputType.type.constraints.minNumFields === 'number' &&
            inputType.type.constraints.minNumFields > 0) ||
          inputType.type.constraints.fields?.some((field) => keys.includes(field)) === false
        ) {
          // continue here
          error = {
            type: 'atLeastOne',
            key,
            inputType: inputType.type,
            atLeastFields: inputType.type.constraints.fields,
          }
        } else if (
          numKeys > 1 &&
          typeof inputType.type.constraints.maxNumFields === 'number' &&
          inputType.type.constraints.maxNumFields < 2
        ) {
          error = {
            type: 'atMostOne',
            key,
            inputType: inputType.type,
            providedKeys: keys,
          }
        }

        return new Arg({
          key,
          value: val === null ? null : objectToArgs(val, inputType.type, context, arg.inputTypes),
          isEnum: inputType.location === 'enumTypes',
          error,
          inputType,
          schemaArg: arg,
        })
      }
    } else {
      return scalarToArg(key, value, arg, inputType, context)
    }
  }

  // the provided arg should be a list, but isn't
  // that's fine for us as we can just turn this into a list with a single item
  // and GraphQL even allows this. We're going the conservative route though
  // and actually generate the [] around the value

  if (!Array.isArray(value) && inputType.isList) {
    // TODO: This "if condition" is just a hack until the query engine is fixed
    if (key !== 'updateMany') {
      value = [value]
    }
  }

  if (inputType.location === 'enumTypes' || inputType.location === 'scalar') {
    // if no value is incorrect
    return scalarToArg(key, value, arg, inputType, context)
  }

  const argInputType = inputType.type as DMMF.InputType
  const hasAtLeastOneError =
    typeof argInputType.constraints?.minNumFields === 'number' && argInputType.constraints?.minNumFields > 0
      ? Array.isArray(value) && value.some((v) => !v || Object.keys(cleanObject(v)).length === 0)
      : false
  let err: AtLeastOneError | undefined | AtMostOneError = hasAtLeastOneError
    ? {
        inputType: argInputType,
        key,
        type: 'atLeastOne',
      }
    : undefined
  if (!err) {
    const hasOneOfError =
      typeof argInputType.constraints?.maxNumFields === 'number' && argInputType.constraints?.maxNumFields < 2
        ? Array.isArray(value) && value.find((v) => !v || Object.keys(cleanObject(v)).length !== 1)
        : false
    if (hasOneOfError) {
      err = {
        inputType: argInputType,
        key,
        type: 'atMostOne',
        providedKeys: Object.keys(hasOneOfError),
      }
    }
  }

  if (!Array.isArray(value)) {
    for (const nestedArgInputType of arg.inputTypes) {
      const args = objectToArgs(value, nestedArgInputType.type as DMMF.InputType, context)
      if (args.collectErrors().length === 0) {
        return new Arg({
          key,
          value: args,
          isEnum: false,
          schemaArg: arg,
          inputType: nestedArgInputType,
        })
      }
    }
  }

  return new Arg({
    key,
    value: value.map((v, i) => {
      if (inputType.isList && typeof v !== 'object') {
        return v
      }
      if (typeof v !== 'object' || !value || Array.isArray(v)) {
        return getInvalidTypeArg(String(i), v, scalarOnlyArg(arg), scalarType(inputType))
      }
      return objectToArgs(v, argInputType, context)
    }),
    isEnum: false,
    inputType,
    schemaArg: arg,
    error: err,
  })
}

/**
 * Turns list input type into scalar - used for reporting
 * mismatched array elements errors.
 * @param listType
 * @returns
 */
function scalarType(listType: DMMF.SchemaArgInputType): DMMF.SchemaArgInputType {
  return {
    ...listType,
    isList: false,
  }
}

/**
 * Filters out all list input types out of an arg, so out
 * of T | T[] union only T will remain. Used for reporting mismatched
 * array element errors
 * @param arg
 * @returns
 */
function scalarOnlyArg(arg: DMMF.SchemaArg): DMMF.SchemaArg {
  return {
    ...arg,
    inputTypes: arg.inputTypes.filter((inputType) => !inputType.isList),
  }
}

export function isInputArgType(argType: DMMF.ArgType): argType is DMMF.InputType {
  if (typeof argType === 'string') {
    return false
  }

  if (Object.hasOwnProperty.call(argType, 'values')) {
    return false
  }

  return true
}

function scalarToArg(
  key: string,
  value: any,
  arg: DMMF.SchemaArg,
  inputType: DMMF.SchemaArgInputType,
  context: MakeDocumentContext,
): Arg {
  if (isDate(value) && !isValidDate(value)) {
    return new Arg({
      key,
      value,
      schemaArg: arg,
      inputType,
      error: {
        type: 'invalidDateArg',
        argName: key,
      },
    })
  }
  if (hasCorrectScalarType(value, inputType, context)) {
    return new Arg({
      key,
      value,
      isEnum: inputType.location === 'enumTypes',
      schemaArg: arg,
      inputType,
    })
  }
  return getInvalidTypeArg(key, value, arg, inputType)
}

function objectToArgs(
  initialObj: any,
  inputType: DMMF.InputType,
  context: MakeDocumentContext,
  possibilities?: DMMF.SchemaArgInputType[],
  outputType?: DMMF.OutputType,
): Args {
  if (inputType.meta?.source) {
    context = { modelName: inputType.meta.source }
  }
  // filter out undefined values and treat them if they weren't provided
  const obj = cleanObject(initialObj)
  const { fields: args, fieldMap } = inputType
  const requiredArgs: any = args.map((arg) => [arg.name, undefined])
  const objEntries = Object.entries(obj || {})
  const entries = unionBy(objEntries, requiredArgs, (a) => a[0])
  const argsList = entries.reduce((acc, [argName, value]: any) => {
    const schemaArg = fieldMap ? fieldMap[argName] : args.find((a) => a.name === argName)
    if (!schemaArg) {
      const didYouMeanField =
        typeof value === 'boolean' && outputType && outputType.fields.some((f) => f.name === argName) ? argName : null
      acc.push(
        new Arg({
          key: argName,
          value,
          error: {
            type: 'invalidName',
            providedName: argName,
            providedValue: value,
            didYouMeanField,
            didYouMeanArg:
              (!didYouMeanField && getSuggestion(argName, [...args.map((a) => a.name), 'select'])) || undefined,
            originalType: inputType,
            possibilities,
            outputType,
          },
        }),
      )
      return acc
    }

    const arg = valueToArg(argName, value, schemaArg, context)

    if (arg) {
      acc.push(arg)
    }

    return acc
  }, [] as Arg[])
  // Also show optional neighbour args, if there is any arg missing
  if (
    (typeof inputType.constraints.minNumFields === 'number' &&
      objEntries.length < inputType.constraints.minNumFields) ||
    argsList.find((arg) => arg.error?.type === 'missingArg' || arg.error?.type === 'atLeastOne')
  ) {
    const optionalMissingArgs = inputType.fields.filter(
      (field) => !field.isRequired && obj && (typeof obj[field.name] === 'undefined' || obj[field.name] === null),
    )
    argsList.push(
      ...optionalMissingArgs.map((arg) => {
        const argInputType = arg.inputTypes[0]
        return new Arg({
          key: arg.name,
          value: undefined,
          isEnum: argInputType.location === 'enumTypes',
          error: {
            type: 'missingArg',
            missingName: arg.name,
            missingArg: arg,
            atLeastOne: Boolean(inputType.constraints.minNumFields) || false,
            atMostOne: inputType.constraints.maxNumFields === 1 || false,
          },
          inputType: argInputType,
        })
      }),
    )
  }
  return new Args(argsList)
}

export interface UnpackOptions {
  document: Document
  path: string[]
  data: any
}

/**
 * Unpacks the result of a data object and maps DateTime fields to instances of `Date` in-place
 * @param options: UnpackOptions
 */
export function unpack({ document, path, data }: UnpackOptions): any {
  const result = deepGet(data, path)

  if (result === 'undefined') {
    return null
  }

  if (typeof result !== 'object') {
    return result
  }

  const field = getField(document, path)

  return mapScalars({ field, data: result })
}

export interface MapScalarsOptions {
  field: Field
  data: any
}

export function mapScalars({ field, data }: MapScalarsOptions): any {
  if (!data || typeof data !== 'object' || !field.children || !field.schemaField) {
    return data
  }

  const deserializers = {
    DateTime: (value) => new Date(value),
    Json: (value) => JSON.parse(value),
    Bytes: (value) => Buffer.from(value, 'base64'),
    Decimal: (value) => {
      return new Decimal(value)
    },
    BigInt: (value) => BigInt(value),
  }

  for (const child of field.children) {
    const outputType = child.schemaField?.outputType.type
    if (outputType && typeof outputType === 'string') {
      const deserializer = deserializers[outputType]
      if (deserializer) {
        if (Array.isArray(data)) {
          for (const entry of data) {
            // in the very unlikely case, that a field is not there in the result, ignore it
            if (typeof entry[child.name] !== 'undefined' && entry[child.name] !== null) {
              // for scalar lists
              if (Array.isArray(entry[child.name])) {
                entry[child.name] = entry[child.name].map(deserializer)
              } else {
                entry[child.name] = deserializer(entry[child.name])
              }
            }
          }
        } else {
          // same here, ignore it if it's undefined
          if (typeof data[child.name] !== 'undefined' && data[child.name] !== null) {
            // for scalar lists
            if (Array.isArray(data[child.name])) {
              data[child.name] = data[child.name].map(deserializer)
            } else {
              data[child.name] = deserializer(data[child.name])
            }
          }
        }
      }
    }

    if (child.schemaField && child.schemaField.outputType.location === 'outputObjectTypes') {
      if (Array.isArray(data)) {
        for (const entry of data) {
          mapScalars({ field: child, data: entry[child.name] })
        }
      } else {
        mapScalars({ field: child, data: data[child.name] })
      }
    }
  }

  return data
}

export function getField(document: Document, path: string[]): Field {
  const todo = path.slice() // let's create a copy to not fiddle with the input argument
  const firstElement = todo.shift()
  // this might be slow because of the find
  let pointer = document.children.find((c) => c.name === firstElement)

  if (!pointer) {
    throw new Error(`Could not find field ${firstElement} in document ${document}`)
  }

  while (todo.length > 0) {
    const key = todo.shift()
    if (!pointer!.children) {
      throw new Error(`Can't get children for field ${pointer} with child ${key}`)
    }
    const child = pointer!.children.find((c) => c.name === key)
    if (!child) {
      throw new Error(`Can't find child ${key} of field ${pointer}`)
    }
    pointer = child
  }

  return pointer!
}

function removeSelectFromPath(path: string): string {
  return path
    .split('.')
    .filter((p) => p !== 'select')
    .join('.')
}

function removeSelectFromObject(obj: object): object {
  const type = Object.prototype.toString.call(obj)
  if (type === '[object Object]') {
    const copy = {}
    for (const key in obj) {
      if (key === 'select') {
        for (const subKey in obj['select']) {
          copy[subKey] = removeSelectFromObject(obj['select'][subKey])
        }
      } else {
        copy[key] = removeSelectFromObject(obj[key])
      }
    }
    return copy
  }

  return obj
}

function transformAggregatePrintJsonArgs({
  ast,
  keyPaths,
  missingItems,
  valuePaths,
}: PrintJsonWithErrorsArgs): PrintJsonWithErrorsArgs {
  const newKeyPaths = keyPaths.map(removeSelectFromPath)
  const newValuePaths = valuePaths.map(removeSelectFromPath)
  const newMissingItems = missingItems.map((item) => ({
    path: removeSelectFromPath(item.path),
    isRequired: item.isRequired,
    type: item.type,
  }))

  const newAst = removeSelectFromObject(ast)
  return {
    ast: newAst,
    keyPaths: newKeyPaths,
    missingItems: newMissingItems,
    valuePaths: newValuePaths,
  }
}
