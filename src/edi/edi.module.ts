import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { VesselModule } from '../vessel/vessel.module';
import { EdiController } from './edi.controller';

@Module({ imports: [VesselModule, InventoryModule], controllers: [EdiController] })
export class EdiModule {}
