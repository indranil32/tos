import { Module } from '@nestjs/common';
import { VesselModule } from '../vessel/vessel.module';
import { EdiController } from './edi.controller';

@Module({ imports: [VesselModule], controllers: [EdiController] })
export class EdiModule {}
