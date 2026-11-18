import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { GateController } from './gate.controller';

@Module({ imports: [InventoryModule], controllers: [GateController] })
export class GateModule {}
