# Supplier.id — Referensi API (v1)

Base URL: `/api`. Auth: header `Authorization: Bearer <token>` (JWT dari `/auth/login`). Semua nilai uang Rupiah (number). Peran: `ADMIN`, `SUPPLIER`, `BUYER`.
Error: `{ error: "KODE", details?: any }` dengan status 400/401/403/404/409.

## Auth
| Method | Path | Peran | Body / Catatan |
|---|---|---|---|
| POST | /auth/register | publik | `{email,password,name,role:'SUPPLIER'|'BUYER',orgName,supplierKind?,taxStatus:'PKP'|'NON_PKP',region?,address?}` → `{token,user,organization}` |
| POST | /auth/login | publik | `{email,password}` → `{token,user:{id,email,name,role,orgId},organization}` |
| GET | /auth/me | semua | `{user, organization}` |

## Katalog publik
| GET | /categories | — | `[{id,code,name,attribute_schema:[{key,label,type:'select'|'text'|'number'|'date',required,options?,unit?}],tax_class,min_photos}]` |
| GET | /reason-codes | — | `[{code,label,requires_video,active}]` |
| GET | /declaration | — | versi aktif `{version,title,body}` |
| GET | /listings?category=&commodity=&region=&status= | — | batch yang dipublikasikan: `{id,batch_code,status,type,grade,quantity,available_quantity,unit,price_per_unit,product_name,commodity,category_code,supplier_name,supplier_region,supplier_status,supplier_quality_score,photo_count,harvest_stage,expected_harvest_date,...}` |
| GET | /listings/:batchId | — | detail + `photos[]`, `harvest`, `declaration`, `supplier_quality`, `attribute_schema`, `attributes` |

## Bukti foto/video (multipart/form-data)
POST `/evidence` — field `file` (image/* atau video/*) + metadata:
`owner_type` (`BATCH`|`HARVEST_CURRENT`|`HARVEST_PRE`|`HARVEST_FINAL`|`INSPECTION`|`RETURN`|`SHIPMENT`), `kind` (`OVERALL`|`CLOSEUP`|`PACKAGING`|`CURRENT`|`PRE_HARVEST`|`FINAL`|`RECEIVING_PHOTO`|`RECEIVING_VIDEO`|`RETURN_PHOTO`|`RETURN_VIDEO`|`PICKUP`|`OTHER`), `batch_id?`, `order_id?`, `taken_at?`, `lat?`, `lng?`, `location_consent?` (lokasi hanya disimpan jika true), `is_stock_image` (true → ditolak 400 `STOCK_IMAGE_NOT_ALLOWED`).
Video wajib untuk kind `*_VIDEO`. Response: baris `evidence_files` (`file_path` → tampilkan via `/uploads/<file_path>`).
GET `/evidence?batch_id=|order_id=|return_case_id=`.

## Supplier (`/supplier/*`, peran SUPPLIER; ADMIN boleh dengan `?supplier_id=`)
| GET | /supplier/products | `[{...product, category_code, category_name, attribute_schema, batch_count}]` |
| POST | /supplier/products | `{category_id,name,commodity,variety?,unit,origin?,production_method?,certification?}` |
| GET | /supplier/batches | `[{...batch, product_name, category_code, harvest_stage, photo_count}]` |
| GET | /supplier/batches/:id | batch + `photos[]`, `harvest`, `acceptance`, `attribute_schema`, `readiness:{ok,missing_fields[],photos,min_photos,missing_photo_kinds[]}` |
| POST | /supplier/batches | `{product_id,type:'READY_STOCK'|'HARVEST',grade?,quantity,unit,expected_weight_kg?,weight_tolerance_pct?,harvest_date?,availability_date?,condition?,size?,color?,freshness?,moisture?,temperature_c?,shelf_life_days?,expiry_date?,attributes:{...dinamis},price_per_unit, harvest?:{planting_date?,expected_harvest_date,expected_quantity,expected_grade?,expected_quality?,current_condition?,forecast_confidence?}}` |
| PATCH | /supplier/batches/:id | subset field di atas |
| POST | /supplier/batches/:id/publish | `{accepted:true, declaration_version}` → READY_FOR_ORDER (ready stock) / UPCOMING (harvest). 400 `DECLARATION_INCOMPLETE` + `details=readiness`; 409 `SUPPLIER_LISTING_RESTRICTED` |
| POST | /supplier/batches/:id/harvest/pre-update | butuh ≥1 foto owner_type HARVEST_PRE. `{current_condition,forecast_confidence?,expected_quantity?,expected_harvest_date?,note?}` |
| POST | /supplier/batches/:id/harvest/finalize | butuh ≥min foto HARVEST_FINAL. `{actual_quantity,actual_grade,actual_weight_kg?,actual_condition,actual_harvest_date,attributes?,price_per_unit?,accepted:true,declaration_version}` → READY_FOR_ORDER |
| GET | /supplier/harvest/reminders | panen yang perlu pre-harvest update (H-n) |
| GET | /supplier/dashboard | `{summary:{product_value,adjustment,supplier_receivable,paid,pending}, orders:[{...,supplier_receivable,return_deduction,paid}], payouts[], quality, organization}` |

## RFQ & negosiasi
| POST | /rfqs | BUYER `{category_id?,batch_id?,commodity,quantity,unit,target_price?,required_grade?,delivery_address?,delivery_region?,distance_km,needed_by?}` |
| GET | /rfqs | BUYER: miliknya (+`quote_count`); SUPPLIER: terbuka + `matched`, `my_quotes`; ADMIN: semua |
| GET | /rfqs/:id | + `quotations[]` (`proposed_by`, `round`, `status`, `price_per_unit`, `quantity`, `supplier_name`, `batch_code`) |
| POST | /rfqs/:id/quotations | SUPPLIER `{batch_id,price_per_unit,quantity,message?,valid_until?}` |
| POST | /quotations/:id/counter | BUYER/SUPPLIER (pihak lawan) `{price_per_unit,quantity?,message?}` |
| POST | /quotations/:id/accept | pihak lawan `{optional_service_codes?,promo_code?,distance_km?}` → order DRAFT |

## Order lifecycle
| POST | /orders/preview | BUYER `{batch_id,quantity,unit_price?,distance_km,optional_service_codes[],promo_code?}` → PricingResult `{productValue,platformFeeRate,platformFeeAmount,packagingAmount,logisticsAmount,paymentFeeAmount,optionalAmount,optionalLines[],discountAmount,discountLine,subtotalBeforeTax,taxAmount,taxLines[{component,rule,base,dpp,rate,amount,taxable}],totalAmount,costBasis,feeConfig}` |
| POST | /orders | BUYER body sama + `delivery_address?` → order DRAFT |
| GET | /orders | list sesuai peran (`product_name,supplier_name,buyer_name,batch_code`) |
| GET | /orders/:id | detail lengkap: order + `events[]`, `payments[]`, `shipments[{...,events[]}]`, `inspection`, `return_cases[]`, `ledger[]`, `evidence[]`, `adjustments[]`; `pricing_snapshot` |
| POST | /orders/:id/confirm | BUYER → PENDING_PAYMENT (snapshot terkunci) |
| POST | /orders/:id/pay | BUYER `{channel?}` → `{order,payment}` PAID |
| POST | /orders/:id/pack | SUPPLIER `{packaging_type?,actual_packaging_cost?}` → PACKING |
| POST | /orders/:id/pickup | SUPPLIER `{carrier?,driver_name?,vehicle?,packaging_type?,cold_chain?,logistics_cost?}` → `{order,shipment}` PICKED_UP |
| POST | /shipments/:id/events | SUPPLIER/ADMIN `{event_type:'CHECKPOINT'|'TEMPERATURE'|'DELAY'|...,location?,lat?,lng?,temperature_c?,note?}` |
| POST | /shipments/:id/arrive | SUPPLIER/ADMIN → ARRIVED_WAITING_INSPECTION |
| POST | /orders/:id/inspection | BUYER `{decision:'ACCEPT'|'PARTIAL_ACCEPT'|'REJECT',accepted_quantity?,reason_code?,description?,measured_weight_kg?,measured_temperature_c?,notes?}` → `{order,inspection,return_case}`; klaim butuh evidence INSPECTION RECEIVING_PHOTO + RECEIVING_VIDEO (400 `RECEIVING_EVIDENCE_REQUIRED`) |
| POST | /orders/:id/cancel | `{reason}` |
| GET | /orders/:id/reconcile | ADMIN |

Status order: DRAFT → PENDING_PAYMENT → PAID → PACKING → PICKED_UP → IN_TRANSIT → ARRIVED_WAITING_INSPECTION → ACCEPTED | PARTIALLY_ACCEPTED | REJECTED → (DISPUTED) → SETTLED; CANCELLED.

## Retur & dispute
| GET | /returns | list sesuai peran (`reason_label,order_no,product_name,supplier_name,buyer_name,dispute_status`) |
| GET | /returns/:id | `{case,order,dispute,before_delivery:{supplier_photos,declaration,harvest,declared},delivery:{pickup_timestamp,arrived_timestamp,duration_hours,route,events,packaging,cold_chain,carrier},at_receiving:{buyer_photos,buyer_videos,timestamp,reported_damage,reason_code,quantity_affected,description,measured_*,decision},signals[],possible_sources[],guidance,adjustments[],return_shipment}` |
| GET | /returns/:id/evidence-comparison | ADMIN (sama tanpa adjustments) |
| POST | /returns/:id/dispute | SUPPLIER/BUYER `{statement}` |
| POST | /returns/:id/decide | ADMIN `{decision:'APPROVED'|'PARTIALLY_APPROVED'|'REJECTED',approved_quantity?,fault_attribution:'SUPPLIER'|'PACKAGING'|'LOGISTICS'|'BUYER_RECEIVING'|'OTHER'|'UNDETERMINED',notes,return_logistics_cost?}` → `{return_case, adjustment:{adjustment,computed:{ratio,components[{component,mode,base,refund,taxReversal,bearer?}],refundToBuyer,supplierDeduction,platformAbsorbed,logisticsRecovery,taxReversal,returnLogistics:{cost,bearer,allocation}},netRefund}}` |
| POST | /returns/:id/pickup | `{carrier?,driver_name?,vehicle?}` → shipment RETURN |
| POST | /returns/:id/receive | SUPPLIER/ADMIN `{notes?}` → CLOSED, order SETTLED |

## Admin (`/admin/*`)
| GET | /admin/fees | `{current:{id,rate_percent,scope_type,scope_ref,effective_from}, history[], requires_approval}` |
| POST | /admin/fees | `{rate_percent,scope_type?,scope_ref?,effective_from?,effective_to?,reason}` |
| POST | /admin/fees/:id/approve · /reject `{reason}` |
| GET/POST/PATCH | /admin/tax-rules | `{name,component,transaction_type,seller_status,buyer_status,service_type,taxable,rate_percent,dpp_factor,priority,effective_from?}` |
| GET | /admin/settings · PUT /admin/settings/:key `{value,reason?}` | kunci: `evidence.min_photos`, `evidence.required_kinds`, `packaging.rate_per_kg`, `packaging.cost_ratio`, `logistics.*`, `payment.*`, `return.claim_window_hours`, `return.require_video`, `return.policy`, `quality.weights`, `quality.enforcement`, `optional_services`, `promotions`, `fee.change_requires_approval` |
| GET/PUT | /admin/reason-codes(/:code) `{label,requires_video,active,sort_order}` |
| PUT | /admin/categories/:code `{name,attribute_schema,tax_class,min_photos?,packaging_rate_per_unit?,active}` |
| GET | /admin/organizations?type=SUPPLIER|BUYER · PATCH /admin/organizations/:id `{status?,verified?,tax_status?,reason?}` |
| GET | /admin/quality · POST /admin/quality/recompute `{supplier_id?}` |
| GET | /admin/ledger?order_id=&account=&limit= · GET /admin/ledger/balances · GET /admin/reconcile?order_id= · GET /admin/audit-logs |
| GET | /admin/payouts `{pending:[{supplier_id,supplier_name,payable_balance,settled_unpaid_orders}],history[]}` · POST /admin/payouts/run `{supplier_id}` |
| GET | /admin/monetization?from=&to= | `{cards:{gmv,paid_orders,product_value,platform_fee_revenue,average_take_rate_pct,packaging_revenue,packaging_cost,packaging_profit,logistics_revenue,logistics_cost,logistics_margin,payment_fees_collected,payment_processing_fee,optional_service_revenue,promotion_discount,tax,refunds,return_cases,return_cost,logistics_recovery,supplier_payable,net_revenue}, charts:{gmv_by_day[{day,gmv,revenue,platform_fee}],revenue_by_category[],revenue_by_buyer[],revenue_by_supplier[]}, current_platform_fee, reconciliation}` |
