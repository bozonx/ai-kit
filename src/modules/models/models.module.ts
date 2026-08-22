import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ModelsService } from './models.service.js';

/**
 * Module for LLM models management
 */
@Module({
  imports: [HttpModule],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule { }
