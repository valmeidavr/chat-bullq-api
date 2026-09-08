import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TemplateButtonDto {
  @ApiProperty({ enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] })
  @IsIn(['QUICK_REPLY', 'URL', 'PHONE_NUMBER'])
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';

  @ApiProperty() @IsString() @MaxLength(40) text: string;
  @ApiPropertyOptional() @IsOptional() @IsString() url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
}

export class CreateTemplateDto {
  @ApiProperty({ example: 'boas_vindas', description: 'Nome (a-z, 0-9, _)' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ description: 'Canal Twilio; se omitido usa o primeiro da org' })
  @IsOptional()
  @IsString()
  channelId?: string;

  @ApiPropertyOptional({ example: 'pt_BR' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiProperty({ enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'] })
  @IsIn(['MARKETING', 'UTILITY', 'AUTHENTICATION'])
  category: string;

  @ApiProperty({ example: 'Olá {{1}}, seu pedido {{2}} foi confirmado.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  body: string;

  @ApiPropertyOptional({ type: [TemplateButtonDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateButtonDto)
  buttons?: TemplateButtonDto[];
}
