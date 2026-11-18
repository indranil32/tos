import { Module } from '@nestjs/common';
import { UnitsController } from './units.controller';
import { VgmService } from './vgm.service';
import { YardAllocator } from './yard-allocator';

@Module({ controllers: [UnitsController], providers: [YardAllocator, VgmService], exports: [YardAllocator, VgmService] })
export class InventoryModule {}
