/**
 * Story 10-5.2 AC9 — ResetSettingsDto.
 *
 * Reset validation DTO. `keys` is an array of valid setting key strings.
 * Empty array means "reset all Category B keys" (excluding bankrollUsd).
 */
import {
  IsArray,
  IsString,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { RESETTABLE_SETTINGS_KEYS } from '../../common/config/settings-metadata.js';

@ValidatorConstraint({ name: 'isValidSettingsKey', async: false })
class IsValidSettingsKey implements ValidatorConstraintInterface {
  validate(keys: unknown, _args: ValidationArguments): boolean {
    if (!Array.isArray(keys)) return false;
    // Empty array is valid (reset all)
    if (keys.length === 0) return true;
    // Each key must be a valid resettable settings key
    return keys.every(
      (k) => typeof k === 'string' && RESETTABLE_SETTINGS_KEYS.includes(k),
    );
  }

  defaultMessage(args: ValidationArguments): string {
    const keys = args.value as unknown[];
    if (!Array.isArray(keys)) return 'keys must be an array';
    const invalid = keys.filter(
      (k) => typeof k !== 'string' || !RESETTABLE_SETTINGS_KEYS.includes(k),
    );
    return `Invalid setting keys: ${invalid.join(', ')}. bankrollUsd cannot be reset via this endpoint.`;
  }
}

export class ResetSettingsDto {
  @IsArray()
  @IsString({ each: true })
  @Validate(IsValidSettingsKey)
  keys!: string[];
}
