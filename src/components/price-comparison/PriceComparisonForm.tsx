"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, FileText, Loader2, Plus, Save, Send, Trash2 } from "lucide-react";
import {
    addDoc,
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    orderBy,
    query,
    serverTimestamp,
    updateDoc,
    where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/context/AuthContext";
import type { PurchaseRequisition } from "@/types/pr";
import type { Vendor } from "@/types/vendor";
import type { Contractor } from "@/types/contractor";
import type {
    ComparisonRecommendationType,
    ComparisonSupplierQuote,
    ComparisonSupplierQuoteItem,
    ComparisonSupplierType,
    PriceComparison,
} from "@/types/priceComparison";
import {
    buildPendingPriceComparisonApprovalTrail,
    getAutoRecommendedQuote,
    getRecommendationTypeLabel,
    rankPriceComparisonQuotes,
    shouldRequireManualRecommendationReason,
} from "@/lib/priceComparison";
import {
    buildDocumentNumber,
    buildDocumentPrefix,
    normalizeProjectCode,
    parseDocumentSequence,
} from "@/lib/documentNumbers";
import {
    QuoteItemsTable,
    QuoteTotalsGrid,
    formatMoney,
    getFulfillmentTypeLabel,
    getRequestTypeLabel,
    getSelectedQuote,
    getVatModeLabel,
} from "@/components/price-comparison/PriceComparisonDocument";

type PriceComparisonFormProps = {
    mode: "create" | "edit";
    comparison?: PriceComparison | null;
    comparisonId?: string;
    backHref?: string;
    missingRequisitionHref?: string;
    redirectAfterSaveHref?: string;
    redirectAfterSaveBasePath?: string;
};

type ProjectRecord = {
    id: string;
    name?: string;
    code?: string;
};

type SupplierOption = {
    id: string;
    label: string;
    detail?: string;
};

type SaveIntent = "draft" | "pending_approval" | null;

const fieldClassName =
    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none transition focus:border-slate-950";

const compactFieldClassName =
    "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 outline-none transition focus:border-slate-950";

function FieldLabel({ children }: { children: string }) {
    return (
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {children}
        </label>
    );
}

function SectionCard({
    title,
    description,
    actions,
    children,
}: {
    title: string;
    description?: string;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
                    {description ? <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p> : null}
                </div>
                {actions ? <div className="shrink-0">{actions}</div> : null}
            </div>
            <div className="mt-4">{children}</div>
        </section>
    );
}

function SummaryValue({
    label,
    value,
    className = "",
}: {
    label: string;
    value: ReactNode;
    className?: string;
}) {
    return (
        <div className={`rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 ${className}`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
            <div className="mt-1 text-sm font-semibold text-slate-950">{value}</div>
        </div>
    );
}

function getSupplierTypeFromPr(requisition: PurchaseRequisition): ComparisonSupplierType {
    return requisition.requestType === "service" || requisition.fulfillmentType === "wc"
        ? "contractor"
        : "vendor";
}

function createQuoteItem(source: PurchaseRequisition["items"][number], id: string): ComparisonSupplierQuoteItem {
    return {
        id,
        requisitionItemId: source.id,
        description: source.description,
        quantity: Number(source.quantity) || 0,
        unit: source.unit || "",
        unitPrice: 0,
        amount: 0,
        remark: "",
        isCompliant: true,
    };
}

function createEmptyQuote(id: string, supplierType: ComparisonSupplierType, requisition: PurchaseRequisition): ComparisonSupplierQuote {
    return {
        id,
        supplierType,
        supplierId: "",
        supplierName: "",
        quotedAt: "",
        quoteRef: "",
        vatMode: requisition.vatMode || "exclusive",
        vatRate: 0,
        creditDays: 0,
        deliveryDays: 0,
        items: requisition.items.map((item, index) => createQuoteItem(item, `${id}-item-${index}`)),
        subTotal: 0,
        vatAmount: 0,
        totalAmount: 0,
        note: "",
        overallRank: 0,
    };
}

export default function PriceComparisonForm({
    mode,
    comparison,
    comparisonId,
    backHref,
    missingRequisitionHref,
    redirectAfterSaveHref,
    redirectAfterSaveBasePath,
}: PriceComparisonFormProps) {
    const { user, userProfile } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const requisitionId = mode === "create" ? (searchParams.get("prId") || "") : (comparison?.prId || "");

    const [loading, setLoading] = useState(mode === "edit");
    const [bootstrapped, setBootstrapped] = useState(false);
    const [requisition, setRequisition] = useState<PurchaseRequisition | null>(null);
    const [project, setProject] = useState<ProjectRecord | null>(null);
    const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
    const [comparisonNumber, setComparisonNumber] = useState("");
    const [quotes, setQuotes] = useState<ComparisonSupplierQuote[]>([]);
    const [recommendationType, setRecommendationType] = useState<ComparisonRecommendationType>("lowest_price");
    const [recommendedQuoteId, setRecommendedQuoteId] = useState("");
    const [recommendationReason, setRecommendationReason] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveIntent, setSaveIntent] = useState<SaveIntent>(null);
    const [success, setSuccess] = useState(false);

    const supplierType = requisition ? getSupplierTypeFromPr(requisition) : "vendor";
    const rankedQuotes = rankPriceComparisonQuotes(quotes);
    const matrixQuotes = [...rankedQuotes].sort((left, right) => (left.overallRank || 999) - (right.overallRank || 999));
    const autoRecommendedQuote = getAutoRecommendedQuote(rankedQuotes);
    const selectedQuotePreview = getSelectedQuote({
        quotes: rankedQuotes,
        recommendedQuoteId,
        autoRecommendedQuoteId: autoRecommendedQuote?.id,
    });
    const selectedQuoteId = selectedQuotePreview?.id || "";
    const needsRecommendationReason = shouldRequireManualRecommendationReason({
        recommendationType,
        selectedQuoteId: recommendedQuoteId || autoRecommendedQuote?.id,
        autoRecommendedQuoteId: autoRecommendedQuote?.id,
    });

    useEffect(() => {
        if (!requisitionId) return;

        let active = true;
        async function fetchSource() {
            setLoading(true);
            try {
                const requisitionSnap = await getDoc(doc(db, "purchase_requisitions", requisitionId));
                if (!active || !requisitionSnap.exists()) return;

                const requisitionData = { id: requisitionSnap.id, ...requisitionSnap.data() } as PurchaseRequisition;
                setRequisition(requisitionData);

                const projectSnap = await getDoc(doc(db, "projects", requisitionData.projectId));
                if (!active) return;

                setProject(projectSnap.exists() ? ({ id: projectSnap.id, ...projectSnap.data() } as ProjectRecord) : null);
            } catch (error) {
                console.error("Error fetching comparison source:", error);
            } finally {
                if (active) setLoading(false);
            }
        }

        void fetchSource();
        return () => {
            active = false;
        };
    }, [requisitionId]);

    useEffect(() => {
        if (!requisition) return;

        let active = true;
        async function fetchSuppliers() {
            try {
                const sourceCollection = supplierType === "vendor" ? "vendors" : "contractors";
                const snapshot = await getDocs(query(collection(db, sourceCollection), where("isActive", "==", true)));
                if (!active) return;

                const nextSuppliers: SupplierOption[] = [];
                snapshot.forEach((docSnap) => {
                    if (supplierType === "vendor") {
                        const vendor = { id: docSnap.id, ...docSnap.data() } as Vendor;
                        nextSuppliers.push({ id: vendor.id, label: vendor.name, detail: vendor.taxId || vendor.phone || "" });
                    } else {
                        const contractor = { id: docSnap.id, ...docSnap.data() } as Contractor;
                        nextSuppliers.push({ id: contractor.id || docSnap.id, label: contractor.fullName, detail: contractor.nickname || contractor.phone || "" });
                    }
                });

                nextSuppliers.sort((left, right) => left.label.localeCompare(right.label));
                setSuppliers(nextSuppliers);
            } catch (error) {
                console.error("Error fetching comparison suppliers:", error);
            }
        }

        void fetchSuppliers();
        return () => {
            active = false;
        };
    }, [requisition, supplierType]);

    useEffect(() => {
        if (!requisition || bootstrapped) return;

        if (mode === "edit" && comparison) {
            setComparisonNumber(comparison.comparisonNumber || "");
            setQuotes(Array.isArray(comparison.quotes) ? comparison.quotes : []);
            setRecommendationType(comparison.recommendationType || "lowest_price");
            setRecommendedQuoteId(comparison.recommendedQuoteId || "");
            setRecommendationReason(comparison.recommendationReason || "");
            setBootstrapped(true);
            return;
        }

        const timestamp = Date.now();
        setQuotes([
            createEmptyQuote(`quote-${timestamp}-1`, supplierType, requisition),
            createEmptyQuote(`quote-${timestamp}-2`, supplierType, requisition),
        ]);
        setBootstrapped(true);
    }, [bootstrapped, comparison, mode, requisition, supplierType]);

    useEffect(() => {
        if (mode !== "create" || !project?.code || comparisonNumber) return;

        async function fetchNextComparisonNumber() {
            const projectCode = project?.code;
            if (!projectCode) return;

            const normalizedProjectCode = normalizeProjectCode(projectCode);
            if (!normalizedProjectCode) return;

            const prefix = buildDocumentPrefix({ series: "PC", projectCode: normalizedProjectCode });
            try {
                const snapshot = await getDocs(query(
                    collection(db, "pr_price_comparisons"),
                    where("comparisonNumber", ">=", prefix),
                    where("comparisonNumber", "<=", `${prefix}\uf8ff`),
                    orderBy("comparisonNumber", "desc"),
                    limit(1)
                ));

                let nextSequence = 1;
                if (!snapshot.empty) {
                    const lastNumber = String(snapshot.docs[0].data().comparisonNumber || "");
                    const lastSequence = parseDocumentSequence(lastNumber, prefix);
                    if (lastSequence !== null) nextSequence = lastSequence + 1;
                }

                setComparisonNumber(buildDocumentNumber({
                    series: "PC",
                    projectCode: normalizedProjectCode,
                    sequence: nextSequence,
                }));
            } catch (error) {
                console.error("Error generating comparison number:", error);
            }
        }

        void fetchNextComparisonNumber();
    }, [comparisonNumber, mode, project?.code]);

    const handleQuoteChange = (quoteId: string, field: keyof ComparisonSupplierQuote, value: string | number) => {
        setQuotes((current) => current.map((quote) => {
            if (quote.id !== quoteId) return quote;
            const nextQuote = { ...quote, [field]: value } as ComparisonSupplierQuote;
            if (field === "supplierId") {
                const supplier = suppliers.find((item) => item.id === value);
                nextQuote.supplierName = supplier?.label || "";
            }
            return nextQuote;
        }));
    };

    const handleItemChange = (
        quoteId: string,
        itemId: string,
        field: keyof ComparisonSupplierQuoteItem,
        value: string | number | boolean
    ) => {
        setQuotes((current) => current.map((quote) => {
            if (quote.id !== quoteId) return quote;
            return {
                ...quote,
                items: quote.items.map((item) => {
                    if (item.id !== itemId) return item;
                    const nextItem = { ...item, [field]: value } as ComparisonSupplierQuoteItem;
                    if (field === "unitPrice" || field === "quantity") {
                        nextItem.amount = (Number(nextItem.quantity) || 0) * (Number(nextItem.unitPrice) || 0);
                    }
                    return nextItem;
                }),
            };
        }));
    };

    const handleAddQuote = () => {
        if (!requisition) return;
        setQuotes((current) => [...current, createEmptyQuote(`quote-${Date.now()}`, supplierType, requisition)]);
    };

    const handleRemoveQuote = (quoteId: string) => {
        setQuotes((current) => current.filter((quote) => quote.id !== quoteId));
        if (recommendedQuoteId === quoteId) setRecommendedQuoteId("");
    };

    const persistComparison = async (targetStatus: "draft" | "pending_approval") => {
        if (!requisition || !project || !user) {
            alert("ไม่พบข้อมูล PR หรือผู้ใช้งาน");
            return;
        }

        const sanitizedQuotes = rankPriceComparisonQuotes(
            quotes
                .filter((quote) => quote.supplierId && quote.supplierName)
                .map((quote) => ({
                    ...quote,
                    supplierType,
                    items: quote.items.map((item) => ({
                        ...item,
                        quantity: Number(item.quantity) || 0,
                        unitPrice: Number(item.unitPrice) || 0,
                        amount: (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0),
                        isCompliant: item.isCompliant !== false,
                    })),
                }))
        );

        if (!comparisonNumber.trim()) {
            alert("กรุณาระบุเลขที่เอกสารเทียบราคา");
            return;
        }

        if (sanitizedQuotes.length === 0) {
            alert("กรุณาเลือกผู้เสนอราคาอย่างน้อย 1 ราย");
            return;
        }

        const autoQuote = getAutoRecommendedQuote(sanitizedQuotes);
        const nextRecommendedQuoteId = recommendedQuoteId || autoQuote?.id || "";
        const selectedQuote = sanitizedQuotes.find((quote) => quote.id === nextRecommendedQuoteId);

        if (targetStatus === "pending_approval" && !selectedQuote) {
            alert("กรุณาเลือกผลเทียบราคาที่จะเสนออนุมัติ");
            return;
        }

        if (
            targetStatus === "pending_approval" &&
            shouldRequireManualRecommendationReason({
                recommendationType,
                selectedQuoteId: nextRecommendedQuoteId,
                autoRecommendedQuoteId: autoQuote?.id,
            }) &&
            !recommendationReason.trim()
        ) {
            alert("กรุณาระบุเหตุผลประกอบการเลือก");
            return;
        }

        setSaving(true);
        setSaveIntent(targetStatus);
        try {
            const createdBy = comparison?.createdBy || userProfile?.uid || user.uid;
            const payload = {
                comparisonNumber: comparisonNumber.trim(),
                prId: requisition.id,
                prNumber: requisition.prNumber,
                projectId: requisition.projectId,
                title: requisition.title,
                requestType: requisition.requestType,
                fulfillmentType: requisition.fulfillmentType,
                requestedByUid: requisition.requestedByUid || requisition.createdBy,
                requestedByName: requisition.requestedByName || "",
                sourcingBy: createdBy,
                sourcePrStatus: requisition.status,
                quotes: sanitizedQuotes,
                recommendationType,
                autoRecommendedQuoteId: autoQuote?.id || "",
                recommendedQuoteId: selectedQuote?.id || "",
                ...(selectedQuote?.supplierType ? { recommendedSupplierType: selectedQuote.supplierType } : {}),
                ...(selectedQuote?.supplierId ? { recommendedSupplierId: selectedQuote.supplierId } : {}),
                ...(selectedQuote?.supplierName ? { recommendedSupplierName: selectedQuote.supplierName } : {}),
                recommendedTotalAmount: selectedQuote?.totalAmount || 0,
                recommendationReason: recommendationReason.trim(),
                status: targetStatus,
                approvalTrail: targetStatus === "pending_approval"
                    ? buildPendingPriceComparisonApprovalTrail()
                    : comparison?.approvalTrail || [],
                createdBy,
                updatedAt: serverTimestamp(),
            };

            let savedId = comparisonId || comparison?.id || "";
            if (mode === "edit" && savedId) {
                await updateDoc(doc(db, "pr_price_comparisons", savedId), payload);
            } else {
                const docRef = await addDoc(collection(db, "pr_price_comparisons"), {
                    ...payload,
                    createdAt: serverTimestamp(),
                });
                savedId = docRef.id;
            }

            await updateDoc(doc(db, "purchase_requisitions", requisition.id), {
                currentComparisonId: savedId,
                status: targetStatus === "pending_approval" ? "selection_pending" : "comparing",
                updatedAt: serverTimestamp(),
            });

            if (targetStatus === "pending_approval") {
                try {
                    await fetch("/api/line/notify", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            type: "PC",
                            data: { ...payload, id: savedId },
                            projectName: project.name,
                        }),
                    });
                } catch (error) {
                    console.error("Comparison LINE notification failed:", error);
                }
            }

            setSuccess(true);
            setTimeout(() => {
                const nextHref = redirectAfterSaveBasePath
                    ? `${redirectAfterSaveBasePath}/${savedId}`
                    : redirectAfterSaveHref || `/price-comparisons/${savedId}`;
                router.push(nextHref);
            }, 800);
        } catch (error) {
            console.error("Error saving price comparison:", error);
            alert("บันทึกข้อมูลไม่สำเร็จ");
            setSaving(false);
            setSaveIntent(null);
        }
    };

    const resolvedMissingRequisitionHref = missingRequisitionHref || "/pr";
    const resolvedBackHref = backHref || (mode === "edit" && comparisonId ? `/price-comparisons/${comparisonId}` : requisition ? `/pr/${requisition.id}` : "/pr");

    if (!requisitionId && mode === "create") {
        return (
            <div className="rounded-3xl border border-amber-200 bg-amber-50 p-10 text-center text-amber-900">
                <FileText className="mx-auto mb-4 h-12 w-12 text-amber-500" />
                <h2 className="text-xl font-semibold">ยังไม่ได้เลือก PR ต้นทาง</h2>
                <p className="mt-2 text-sm text-amber-800">เอกสารเทียบราคาต้องสร้างจาก PR ที่ได้รับอนุมัติแล้ว</p>
                <Link href={resolvedMissingRequisitionHref} className="mt-5 inline-flex rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-400">
                    กลับไปหน้า PR
                </Link>
            </div>
        );
    }

    if (loading || !requisition || !bootstrapped) {
        return (
            <div className="flex flex-col items-center justify-center p-12">
                <Loader2 className="mb-4 h-8 w-8 animate-spin text-indigo-600" />
                <p className="text-sm text-slate-500">กำลังโหลดข้อมูลเอกสารเทียบราคา...</p>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-7xl space-y-4">
            <div className="rounded-lg border border-slate-300 bg-white px-4 py-3 print:hidden">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-3">
                        <Link href={resolvedBackHref} className="rounded-md border border-slate-200 p-2 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700">
                            <ArrowLeft size={20} />
                        </Link>
                        <div>
                            <h1 className="text-xl font-semibold tracking-tight text-slate-950">
                                {mode === "edit" ? "แก้ไขเอกสารเทียบราคา" : "สร้างเอกสารเทียบราคา"}
                            </h1>
                            <p className="mt-0.5 text-xs text-slate-500">จัดทำเอกสารให้กระชับ อ่านง่าย และพร้อมเสนออนุมัติ</p>
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={saving || success} onClick={() => void persistComparison("draft")} className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
                            {saving && saveIntent === "draft" ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Save size={15} className="mr-2" />}
                            {success && saveIntent === "draft" ? "บันทึกร่างแล้ว" : "บันทึกร่าง"}
                        </button>
                        <button type="button" disabled={saving || success} onClick={() => void persistComparison("pending_approval")} className="inline-flex items-center justify-center rounded-md bg-slate-950 px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50">
                            {saving && saveIntent === "pending_approval" ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Send size={15} className="mr-2" />}
                            {success && saveIntent === "pending_approval" ? "ส่งอนุมัติแล้ว" : "ส่งขออนุมัติ"}
                        </button>
                    </div>
                </div>
            </div>

            <SectionCard title="ข้อมูลอ้างอิง" description={`PR ${requisition.prNumber || "-"} • ${project?.name || "-"}`}>
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),20rem]">
                    <div className="space-y-3">
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            <div className="sm:col-span-2">
                                <FieldLabel>เลขที่เอกสาร</FieldLabel>
                                <input value={comparisonNumber} onChange={(event) => setComparisonNumber(event.target.value)} className={fieldClassName} />
                            </div>
                            <SummaryValue label="ประเภทคำขอ" value={getRequestTypeLabel(requisition.requestType)} />
                            <SummaryValue label="เอกสารปลายทาง" value={getFulfillmentTypeLabel(requisition.fulfillmentType)} />
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">หัวข้อคำขอ</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{requisition.title}</p>
                            {requisition.reason ? <p className="mt-2 text-sm leading-6 text-slate-600">{requisition.reason}</p> : null}
                        </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                        <SummaryValue label="ผู้ขอ" value={requisition.requestedByName || requisition.createdBy || "-"} />
                        <SummaryValue label="งบประมาณอ้างอิง" value={formatMoney(Number(requisition.totalAmount || 0))} />
                        <SummaryValue label="วันที่ต้องการใช้งาน" value={requisition.requiredDate || "-"} />
                        <SummaryValue label="จำนวนรายการอ้างอิง" value={`${requisition.items.length} รายการ`} />
                    </div>
                </div>
            </SectionCard>

            <SectionCard
                title="สรุปผู้เสนอราคา"
                description="แสดงเฉพาะข้อมูลหลักเพื่อเปรียบเทียบและคัดเลือก"
                actions={(
                    <button type="button" onClick={handleAddQuote} className="inline-flex items-center justify-center rounded-md border border-slate-200 bg-slate-950 px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-slate-800">
                        <Plus size={16} className="mr-2" />
                        เพิ่มผู้เสนอราคา
                    </button>
                )}
            >
                {matrixQuotes.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                        ยังไม่มีผู้เสนอราคา
                    </div>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {matrixQuotes.map((quote) => {
                            const isSelected = selectedQuoteId === quote.id;

                            return (
                                <div key={quote.id} className={`rounded-lg border px-4 py-3 ${isSelected ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white"}`}>
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <p className="text-sm font-semibold text-slate-950">{quote.supplierName || "ยังไม่ได้ระบุผู้เสนอราคา"}</p>
                                            <p className="mt-1 text-xs text-slate-500">Rank {quote.overallRank || "-"} • {quote.quoteRef || "ไม่มีเลขอ้างอิง"}</p>
                                        </div>
                                        {isSelected ? <span className="rounded-md bg-slate-900 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">เลือก</span> : null}
                                    </div>
                                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                                        <SummaryValue label="ยอดรวม" value={formatMoney(Number(quote.totalAmount || 0))} />
                                        <SummaryValue label="VAT" value={getVatModeLabel(quote.vatMode)} />
                                        <SummaryValue label="เครดิต" value={`${quote.creditDays || 0} วัน`} />
                                        <SummaryValue label="ส่งมอบ" value={`${quote.deliveryDays || 0} วัน`} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </SectionCard>

            <SectionCard title="รายละเอียดผู้เสนอราคา">
                <div className="space-y-4">
                    {rankedQuotes.map((quote, index) => {
                        const isSelected = selectedQuoteId === quote.id;

                        return (
                            <article key={quote.id} className="rounded-xl border border-slate-200 bg-white p-4">
                                <div className="flex flex-col gap-3 border-b border-slate-200 pb-3 lg:flex-row lg:items-start lg:justify-between">
                                    <div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="rounded-md border border-slate-200 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                                                ผู้เสนอราคา #{index + 1}
                                            </span>
                                            <span className="rounded-md border border-slate-200 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                                                Rank {quote.overallRank || "-"}
                                            </span>
                                            {isSelected ? (
                                                <span className="rounded-md bg-slate-900 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                                                    ผู้เสนอที่เลือก
                                                </span>
                                            ) : null}
                                        </div>
                                        <p className="mt-2 text-sm font-semibold text-slate-950">{quote.supplierName || "ยังไม่ได้ระบุผู้เสนอราคา"}</p>
                                    </div>
                                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-right">
                                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">ยอดรวมเสนอราคา</p>
                                        <p className="mt-1 text-base font-semibold text-slate-950">{formatMoney(Number(quote.totalAmount || 0))}</p>
                                    </div>
                                </div>

                                <div className="mt-4 space-y-3">
                                    <div className="grid gap-3 xl:grid-cols-[minmax(0,2.2fr),1fr,1fr,1fr,1fr]">
                                        <div>
                                            <FieldLabel>{supplierType === "vendor" ? "ผู้ขาย / คู่ค้า" : "ผู้รับจ้าง"}</FieldLabel>
                                            <select value={quote.supplierId} onChange={(event) => handleQuoteChange(quote.id, "supplierId", event.target.value)} className={fieldClassName}>
                                                <option value="">เลือกผู้เสนอราคา</option>
                                                {suppliers.map((supplier) => (
                                                    <option key={supplier.id} value={supplier.id}>{supplier.label}{supplier.detail ? ` (${supplier.detail})` : ""}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div><FieldLabel>วันที่เสนอราคา</FieldLabel><input type="date" value={quote.quotedAt || ""} onChange={(event) => handleQuoteChange(quote.id, "quotedAt", event.target.value)} className={fieldClassName} /></div>
                                        <div><FieldLabel>เลขอ้างอิง</FieldLabel><input value={quote.quoteRef || ""} onChange={(event) => handleQuoteChange(quote.id, "quoteRef", event.target.value)} className={fieldClassName} /></div>
                                        <div><FieldLabel>เครดิต (วัน)</FieldLabel><input type="number" min="0" value={quote.creditDays || 0} onChange={(event) => handleQuoteChange(quote.id, "creditDays", Number(event.target.value))} className={fieldClassName} /></div>
                                        <div><FieldLabel>ส่งมอบ (วัน)</FieldLabel><input type="number" min="0" value={quote.deliveryDays || 0} onChange={(event) => handleQuoteChange(quote.id, "deliveryDays", Number(event.target.value))} className={fieldClassName} /></div>
                                    </div>

                                    <div className="grid gap-3 xl:grid-cols-[14rem,minmax(0,1fr)]">
                                        <div>
                                            <FieldLabel>VAT</FieldLabel>
                                            <select value={quote.vatMode || "exclusive"} onChange={(event) => handleQuoteChange(quote.id, "vatMode", event.target.value)} className={fieldClassName}>
                                                <option value="none">ไม่มี VAT</option>
                                                <option value="exclusive">VAT 7% แยกจากราคา</option>
                                                <option value="inclusive">VAT 7% รวมในราคา</option>
                                            </select>
                                        </div>
                                        <div>
                                            <FieldLabel>หมายเหตุผู้เสนอราคา</FieldLabel>
                                            <textarea rows={2} value={quote.note || ""} onChange={(event) => handleQuoteChange(quote.id, "note", event.target.value)} className={fieldClassName} placeholder="เงื่อนไขเพิ่มเติมหรือข้อสังเกต" />
                                        </div>
                                    </div>

                                    <QuoteItemsTable
                                        items={quote.items}
                                        editable
                                        renderUnitPrice={(item) => (
                                            <input type="number" min="0" value={item.unitPrice} onChange={(event) => handleItemChange(quote.id, item.id, "unitPrice", Number(event.target.value))} className="w-28 rounded-md border border-slate-300 px-2.5 py-1.5 text-right text-[13px] text-slate-900 outline-none focus:border-slate-950" />
                                        )}
                                        renderRemark={(item) => (
                                            <input value={item.remark || ""} onChange={(event) => handleItemChange(quote.id, item.id, "remark", event.target.value)} className={compactFieldClassName} placeholder="หมายเหตุ" />
                                        )}
                                        renderCompliance={(item) => (
                                            <label className="inline-flex items-center justify-center gap-2">
                                                <input type="checkbox" checked={item.isCompliant !== false} onChange={(event) => handleItemChange(quote.id, item.id, "isCompliant", event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-950" />
                                                <span className="text-sm text-slate-600">{item.isCompliant === false ? "ไม่ผ่าน" : "ผ่าน"}</span>
                                            </label>
                                        )}
                                    />

                                    <QuoteTotalsGrid quote={quote} />

                                    <div className="flex justify-end">
                                        <button type="button" onClick={() => handleRemoveQuote(quote.id)} disabled={rankedQuotes.length <= 1} className="inline-flex items-center justify-center rounded-md border border-rose-200 bg-white px-3 py-2 text-[13px] font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50">
                                            <Trash2 size={16} className="mr-2" />
                                            ลบผู้เสนอราคารายนี้
                                        </button>
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            </SectionCard>

            <SectionCard title="ข้อเสนอเพื่ออนุมัติ">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),20rem]">
                        <div className="space-y-3">
                            <div className="grid gap-3 md:grid-cols-2">
                                <div>
                                    <FieldLabel>เกณฑ์การตัดสิน</FieldLabel>
                                    <select value={recommendationType} onChange={(event) => setRecommendationType(event.target.value as ComparisonRecommendationType)} className={fieldClassName}>
                                        <option value="lowest_price">ราคาต่ำสุด</option>
                                        <option value="best_value">ความคุ้มค่าที่เหมาะสม</option>
                                        <option value="technical_fit">ความเหมาะสมทางเทคนิค</option>
                                    </select>
                                </div>
                                <div>
                                    <FieldLabel>ผู้เสนอที่ต้องการเสนออนุมัติ</FieldLabel>
                                    <select value={recommendedQuoteId} onChange={(event) => setRecommendedQuoteId(event.target.value)} className={fieldClassName}>
                                        <option value="">ใช้คำแนะนำอัตโนมัติ</option>
                                        {matrixQuotes.map((quote) => (
                                            <option key={quote.id} value={quote.id}>Rank {quote.overallRank || "-"} • {quote.supplierName || "ยังไม่ได้ระบุชื่อ"}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div>
                                <FieldLabel>เหตุผลประกอบการเลือก</FieldLabel>
                                <textarea value={recommendationReason} onChange={(event) => setRecommendationReason(event.target.value)} rows={4} className={fieldClassName} placeholder="เช่น เครดิตดีกว่า ส่งมอบเร็วกว่า หรือมีความเหมาะสมทางเทคนิคมากกว่า" />
                            </div>

                            {needsRecommendationReason ? (
                                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
                                    หากเลือกไม่ตรงกับระบบแนะนำหรือใช้เกณฑ์อื่นนอกเหนือจากราคาต่ำสุด ควรระบุเหตุผลให้ชัดเจนเพื่อประกอบการอนุมัติ
                                </div>
                            ) : null}
                        </div>

                        <div className="space-y-2">
                            <SummaryValue label="คำแนะนำอัตโนมัติ" value={autoRecommendedQuote?.supplierName || "-"} />
                            <SummaryValue label="ยอดตามคำแนะนำ" value={autoRecommendedQuote ? `${formatMoney(Number(autoRecommendedQuote.totalAmount || 0))} • Rank ${autoRecommendedQuote.overallRank || "-"}` : "ระบบยังไม่สามารถจัดอันดับได้"} />
                            <SummaryValue label="ผลที่เสนออนุมัติ" value={selectedQuotePreview?.supplierName || "ยังไม่ได้เลือก"} />
                            <SummaryValue label="ยอดที่เสนออนุมัติ" value={selectedQuotePreview ? `${formatMoney(Number(selectedQuotePreview.totalAmount || 0))} • ${getVatModeLabel(selectedQuotePreview.vatMode)}` : "เลือกผู้เสนอราคาเพื่อเตรียมเสนออนุมัติ"} />
                            <SummaryValue label="เกณฑ์และรูปแบบ" value={`${getRecommendationTypeLabel(recommendationType)} • ${getFulfillmentTypeLabel(requisition.fulfillmentType)}`} />
                        </div>
                    </div>
            </SectionCard>
        </div>
    );
}
