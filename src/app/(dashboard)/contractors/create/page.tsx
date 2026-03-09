"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Save, Loader2, User } from "lucide-react";
import { addDoc, collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Contractor } from "@/types/contractor";

export default function CreateContractorPage() {
    const router = useRouter();
    const [saving, setSaving] = useState(false);
    const [isLoadingId, setIsLoadingId] = useState(true);

    const [formData, setFormData] = useState<Partial<Contractor>>({
        idContractor: "",
        nickname: "",
        fullName: "",
        bankAccount: "",
        bankCode: "",
        nationalId: "",
        phone: "",
        address: "",
        yearlyLimit: 1000000,
        isActive: true,
    });

    useEffect(() => {
        const generateContractorId = async () => {
            try {
                const querySnapshot = await getDocs(collection(db, "contractors"));
                let maxId = 0;

                querySnapshot.forEach((doc) => {
                    const data = doc.data() as Contractor;
                    if (data.idContractor && data.idContractor.startsWith("CT")) {
                        const numStr = data.idContractor.replace("CT", "");
                        const num = parseInt(numStr, 10);
                        if (!isNaN(num) && num > maxId) {
                            maxId = num;
                        }
                    }
                });

                const nextId = maxId + 1;
                const formattedId = `CT${nextId.toString().padStart(3, "0")}`;

                setFormData((prev) => ({
                    ...prev,
                    idContractor: formattedId,
                }));
            } catch (error) {
                console.error("Error generating contractor ID:", error);
            } finally {
                setIsLoadingId(false);
            }
        };

        generateContractorId();
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData((prev) => ({
            ...prev,
            [name]:
                name === "isActive" ? value === "true" :
                    name === "yearlyLimit" ? Number(value) : value,
        }));
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!formData.idContractor || !formData.fullName || !formData.phone) {
            alert("กรุณากรอกข้อมูลที่มีดอกจัน (*) ให้ครบถ้วน");
            return;
        }

        setSaving(true);
        try {
            await addDoc(collection(db, "contractors"), {
                idContractor: formData.idContractor.trim(),
                nickname: (formData.nickname || "").trim(),
                fullName: formData.fullName.trim(),
                bankAccount: (formData.bankAccount || "").trim(),
                bankCode: (formData.bankCode || "").trim(),
                nationalId: (formData.nationalId || "").trim(),
                phone: formData.phone.trim(),
                address: (formData.address || "").trim(),
                yearlyLimit: formData.yearlyLimit || 1000000,
                isActive: formData.isActive ?? true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });

            router.push("/contractors");
        } catch (error) {
            console.error("Error adding contractor:", error);
            alert("ไม่สามารถบันทึกข้อมูลลูกจ้างได้ โปรดลองอีกครั้ง");
            setSaving(false);
        }
    };

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            <div className="flex items-center space-x-4">
                <Link href="/contractors" className="p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 rounded-full transition-colors">
                    <ArrowLeft size={20} />
                </Link>
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">เพิ่มข้อมูลลูกจ้างใหม่</h1>
                    <p className="text-sm text-slate-500 mt-1">กรอกรายละเอียดลูกจ้างและข้อมูลบัญชีธนาคาร</p>
                </div>
            </div>

            <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="p-6 md:p-8 space-y-6">
                    <div className="flex items-center space-x-3 mb-6">
                        <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
                            <User size={24} />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-slate-800">ข้อมูลลูกจ้าง</h3>
                            <p className="text-sm text-slate-500">ข้อมูลพื้นฐานและข้อมูลการเงิน</p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">รหัสคู่ค้า <span className="text-red-500">*</span></label>
                            <div className="relative">
                                <input
                                    type="text"
                                    name="idContractor"
                                    required
                                    value={formData.idContractor || ""}
                                    onChange={handleChange}
                                    className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white"
                                />
                                {isLoadingId && (
                                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                        <Loader2 size={16} className="text-blue-500 animate-spin" />
                                    </div>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">ชื่อเล่น</label>
                            <input type="text" name="nickname" value={formData.nickname || ""} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white" />
                        </div>
                        <div className="col-span-1 md:col-span-2">
                            <label className="block text-sm font-medium text-slate-700 mb-1">ชื่อ-นามสกุล <span className="text-red-500">*</span></label>
                            <input type="text" name="fullName" required value={formData.fullName || ""} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white" />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">เลขบัญชี</label>
                            <input type="text" name="bankAccount" value={formData.bankAccount || ""} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">ธนาคาร</label>
                            <select name="bankCode" value={formData.bankCode || ""} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white">
                                <option value="" disabled>-- เลือกธนาคาร --</option>
                                <option value="กรุงเทพ">กรุงเทพ</option>
                                <option value="กสิกรไทย">กสิกรไทย</option>
                                <option value="ไทยพาณิชย์">ไทยพาณิชย์</option>
                                <option value="กรุงไทย">กรุงไทย</option>
                                <option value="ทหารไทย">ทหารไทย</option>
                                <option value="ออมสิน">ออมสิน</option>
                                <option value="กรุงศรีอยุธยา">กรุงศรีอยุธยา</option>
                                <option value="เกียรตินาคิน">เกียรตินาคิน</option>
                                <option value="ธนชาต">ธนชาต</option>
                                <option value="เพื่อการเกษตรและสหกรณ์การเกษตร">เพื่อการเกษตรและสหกรณ์การเกษตร</option>
                                <option value="ยูโอบี">ยูโอบี</option>
                                <option value="ซีไอเอ็มบีไทย">ซีไอเอ็มบีไทย</option>
                                <option value="ทิสโก้">ทิสโก้</option>
                                <option value="อาคารสงเคราะห์">อาคารสงเคราะห์</option>
                                <option value="ธนาคารฮ่องกงและเซี่ยงไฮ้">ธนาคารฮ่องกงและเซี่ยงไฮ้</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">บัตรประชาชน</label>
                            <input type="text" name="nationalId" value={formData.nationalId || ""} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white font-mono" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">เบอร์โทรศัพท์ <span className="text-red-500">*</span></label>
                            <input type="text" name="phone" required value={formData.phone || ""} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white" />
                        </div>

                        <div className="col-span-1 md:col-span-2">
                            <label className="block text-sm font-medium text-slate-700 mb-1">ที่อยู่</label>
                            <textarea name="address" value={formData.address || ""} onChange={handleChange} rows={3} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white" />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">จำกัดยอด/ปี</label>
                            <input type="number" name="yearlyLimit" value={formData.yearlyLimit || 0} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">สถานะใช้งาน</label>
                            <select name="isActive" value={formData.isActive ? "true" : "false"} onChange={handleChange} className="w-full border border-slate-300 rounded-lg py-2 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 bg-white">
                                <option value="true">เปิดใช้งาน</option>
                                <option value="false">ปิดใช้งาน</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div className="bg-slate-50 px-6 py-4 border-t border-slate-200 flex justify-end space-x-3">
                    <Link href="/contractors" className="inline-flex items-center justify-center rounded-lg bg-white border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition-colors">
                        ยกเลิก
                    </Link>
                    <button type="submit" disabled={saving} className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50 transition-colors">
                        {saving ? <Loader2 size={16} className="mr-2 animate-spin" /> : <Save size={16} className="mr-2" />}
                        บันทึกข้อมูลลูกจ้าง
                    </button>
                </div>
            </form>
        </div>
    );
}
