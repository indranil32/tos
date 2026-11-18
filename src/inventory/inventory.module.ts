import { Module } from '@nestjs/common';
import { UnitsController } from './units.controller';
import { YardAllocator } from './yard-allocator';

@Module({ controllers: [UnitsController], providers: [YardAllocator], exports: [YardAllocator] })
export class InventoryModule {}
