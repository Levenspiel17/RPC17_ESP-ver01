/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  FileText, 
  Upload, 
  X, 
  Plus, 
  Send, 
  Loader2, 
  FileSpreadsheet, 
  File as FileIcon, 
  MessageSquare,
  Sparkles,
  ChevronRight,
  History,
  Trash2,
  Download,
  Edit3,
  Save,
  Table as TableIcon,
  Layout,
  Mic,
  MicOff,
} from 'lucide-react';
import {
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  PieChart, 
  Pie, 
  Cell,
  LineChart,
  Line
} from 'recharts';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Gemini Service ---
// Initialize lazily to avoid crashing if key is missing
let aiInstance: GoogleGenAI | null = null;
const getAI = () => {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY || "";
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
};

export interface FileData {
  mimeType: string;
  data: string;
  fileName: string;
}

async function* analyzeFileStream(
  prompt: string,
  fileData?: FileData,
  history: { role: string; parts: { text: string }[] }[] = []
) {
  const ai = getAI();
  const model = "gemini-3-flash-preview";
  const contents = [...history];
  const parts: any[] = [{ text: prompt }];
  
  if (fileData) {
    parts.push({
      inlineData: {
        mimeType: fileData.mimeType,
        data: fileData.data
      }
    });
  }
  
  contents.push({
    role: "user",
    parts
  });

  try {
    const response = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: "You are a professional document analyst. Help the user analyze, summarize, and extract data from their uploaded files. If the user asks for a table, use Markdown table format.",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
      }
    });

    for await (const chunk of response) {
      if (chunk.text) {
        yield chunk.text;
      }
    }
  } catch (error) {
    console.error("AI Stream Error:", error);
    yield "Error: Failed to connect to AI service. Please check your API key.";
  }
}

// --- Types ---
interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

interface ExcelSheet {
  name: string;
  data: string[][];
}

interface DashboardInstance {
  id: string;
  command: string;
  data: any;
  status: 'loading' | 'ready' | 'error';
  timestamp: number;
}

interface FileTab {
  id: string;
  name: string;
  type: string;
  data: string; // base64 or extracted text/html
  mimeType: string;
  messages: ChatMessage[];
  isAnalyzing: boolean;
  view: 'chat' | 'editor' | 'dashboard';
  editorMode: 'text' | 'grid' | 'preview';
  editedContent?: string;
  excelSheets?: ExcelSheet[];
  activeSheetIndex?: number;
  dashboards?: DashboardInstance[];
  activeDashboardId?: string;
}

// --- Main App Component ---
export default function App() {
  console.log("App Rendering...");
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [savedCommands, setSavedCommands] = useState<string[]>(() => {
    const saved = localStorage.getItem('dashboard_commands');
    return saved ? JSON.parse(saved) : [
      "Extract all hazardous chemicals",
      "Summarize import volumes by product",
      "Identify regulatory compliance issues",
      "Compare annual import trends"
    ];
  });
  const [newCommandInput, setNewCommandInput] = useState('');
  const [showCommandInput, setShowCommandInput] = useState(false);

  useEffect(() => {
    localStorage.setItem('dashboard_commands', JSON.stringify(savedCommands));
  }, [savedCommands]);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const workbooksRef = useRef<Record<string, XLSX.WorkBook>>({});

  const [isGoogleAuthenticated, setIsGoogleAuthenticated] = useState(false);
  const [showSheetsModal, setShowSheetsModal] = useState(false);
  const [spreadsheets, setSpreadsheets] = useState<any[]>([]);
  const [isLoadingSheets, setIsLoadingSheets] = useState(false);

  useEffect(() => {
    checkAuthStatus();
    
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) return;
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        checkAuthStatus();
        fetchSpreadsheets();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const checkAuthStatus = async () => {
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      setIsGoogleAuthenticated(data.isAuthenticated);
      if (data.isAuthenticated) fetchSpreadsheets();
    } catch (e) {
      console.error("Auth check error", e);
    }
  };

  const fetchSpreadsheets = async () => {
    setIsLoadingSheets(true);
    try {
      const res = await fetch('/api/sheets/list');
      if (res.ok) {
        const data = await res.json();
        setSpreadsheets(data);
      }
    } catch (e) {
      console.error("Fetch sheets error", e);
    } finally {
      setIsLoadingSheets(false);
    }
  };

  const connectGoogle = async () => {
    try {
      const res = await fetch('/api/auth/google/url');
      const { url } = await res.json();
      window.open(url, 'google_oauth', 'width=600,height=700');
    } catch (e) {
      console.error("Connect error", e);
    }
  };

  const importSpreadsheet = async (spreadsheetId: string) => {
    setIsLoadingSheets(true);
    try {
      const res = await fetch(`/api/sheets/${spreadsheetId}`);
      if (res.ok) {
        const data = await res.json();
        const id = Math.random().toString(36).substring(7);
        
        const excelSheets: ExcelSheet[] = data.sheets.map((s: any) => ({
          name: s.name,
          data: s.data
        }));

        const firstSheetData = excelSheets[0].data;
        const csvData = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(firstSheetData));

        const newTab: FileTab = {
          id,
          name: data.name || "Google Sheet",
          type: 'application/vnd.google-apps.spreadsheet',
          data: csvData,
          mimeType: 'text/csv',
          messages: [],
          isAnalyzing: false,
          view: 'editor',
          editorMode: 'grid',
          editedContent: csvData,
          excelSheets,
          activeSheetIndex: 0
        };

        setTabs(prev => [...prev, newTab]);
        setActiveTabId(id);
        setShowSheetsModal(false);
      }
    } catch (e) {
      console.error("Import error", e);
    } finally {
      setIsLoadingSheets(false);
    }
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  useEffect(() => {
    console.log("App Mounted");
  }, []);

  useEffect(() => {
    if (activeTab?.messages) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeTab?.messages, activeTab?.isAnalyzing]);

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files) return;

    for (const file of Array.from(files)) {
      const id = Math.random().toString(36).substring(7);
      let data = '';
      let mimeType = file.type;
      let excelSheets: ExcelSheet[] = [];
      let editorMode: 'text' | 'grid' | 'preview' = 'preview';

      try {
        if (file.type === 'application/pdf' || file.type.startsWith('image/')) {
          data = await fileToBase64(file);
          editorMode = 'preview';
        } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv')) {
          const buffer = await file.arrayBuffer();
          const workbook = XLSX.read(buffer, { type: 'array', cellStyles: false, cellDates: true, cellNF: false });
          workbooksRef.current[id] = workbook;
          
          // Only parse sheet names first to be fast
          workbook.SheetNames.forEach(name => {
            excelSheets.push({ name, data: [] }); // Data will be lazy-loaded
          });
          
          // Load first sheet data
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as string[][];
          excelSheets[0].data = jsonData;
          
          data = XLSX.utils.sheet_to_csv(firstSheet);
          mimeType = 'text/csv';
          editorMode = 'grid';
        } else if (file.name.endsWith('.docx')) {
          const buffer = await file.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
          data = result.value;
          mimeType = 'text/html';
          editorMode = 'preview';
        } else {
          data = await file.text();
          mimeType = 'text/plain';
          editorMode = 'text';
        }

        const newTab: FileTab = {
          id,
          name: file.name,
          type: file.type || 'text/plain',
          data,
          mimeType: mimeType || 'text/plain',
          messages: [],
          isAnalyzing: false,
          view: 'chat',
          editorMode,
          editedContent: data,
          excelSheets: excelSheets.length > 0 ? excelSheets : undefined,
          activeSheetIndex: excelSheets.length > 0 ? 0 : undefined
        };

        setTabs(prev => [...prev, newTab]);
        setActiveTabId(id);
      } catch (error) {
        console.error("File processing error:", error);
        alert(`Failed to process ${file.name}`);
      }
    }
  };

  const analyzeFile = async (tab: FileTab, prompt: string) => {
    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, isAnalyzing: true } : t));
    
    let fullResponse = '';
    const history = tab.messages.map(m => ({
      role: m.role,
      parts: [{ text: m.content }]
    }));

    const fileData: FileData | undefined = (tab.mimeType !== 'text/plain' && tab.mimeType !== 'text/csv') ? {
      mimeType: tab.mimeType,
      data: tab.data,
      fileName: tab.name
    } : undefined;

    const content = tab.editedContent || tab.data;
    const truncatedContent = content.length > 30000 ? content.substring(0, 30000) + "\n...[Content truncated for speed]..." : content;

    const finalPrompt = (tab.mimeType === 'text/plain' || tab.mimeType === 'text/csv')
      ? `Context from file:\n${truncatedContent}\n\nUser Question: ${prompt}`
      : prompt;

    try {
      const stream = analyzeFileStream(finalPrompt, fileData, history);
      
      setTabs(prev => prev.map(t => t.id === tab.id ? {
        ...t,
        messages: [...t.messages, { role: 'user', content: prompt }, { role: 'model', content: '' }]
      } : t));

      let lastUpdate = Date.now();
      for await (const chunk of stream) {
        fullResponse += chunk;
        const now = Date.now();
        // Throttle UI updates to every 100ms for better performance
        if (now - lastUpdate > 100) {
          setTabs(prev => prev.map(t => t.id === tab.id ? {
            ...t,
            messages: t.messages.map((m, i) => 
              i === t.messages.length - 1 ? { ...m, content: fullResponse } : m
            )
          } : t));
          lastUpdate = now;
        }
      }
      // Final update to ensure everything is rendered
      setTabs(prev => prev.map(t => t.id === tab.id ? {
        ...t,
        messages: t.messages.map((m, i) => 
          i === t.messages.length - 1 ? { ...m, content: fullResponse } : m
        )
      } : t));
    } catch (error) {
      console.error(error);
      setTabs(prev => prev.map(t => t.id === tab.id ? {
        ...t,
        messages: [...t.messages, { role: 'model', content: "I'm sorry, I encountered an error analyzing this file." }]
      } : t));
    } finally {
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, isAnalyzing: false } : t));
    }
  };

  const generateDashboardData = async (tab: FileTab, customCommand?: string) => {
    const dashboardId = Math.random().toString(36).substring(7);
    const command = customCommand || "General Analysis";
    
    const newDashboard: DashboardInstance = {
      id: dashboardId,
      command,
      data: null,
      status: 'loading',
      timestamp: Date.now()
    };

    setTabs(prev => prev.map(t => t.id === tab.id ? { 
      ...t, 
      dashboards: [...(t.dashboards || []), newDashboard],
      activeDashboardId: dashboardId
    } : t));
    
    const ai = getAI();
    const model = "gemini-3-flash-preview";
    
    const fileData: FileData | undefined = (tab.mimeType !== 'text/plain' && tab.mimeType !== 'text/csv') ? {
      mimeType: tab.mimeType,
      data: tab.data,
      fileName: tab.name
    } : undefined;

    const basePrompt = `FAST JSON EXTRACTION:
    {
      "summary": { "totalVolume": number, "hazardousCount": number, "regulationCount": number, "topChemical": "string" },
      "annualImportByChemical": [{ "name": "string", "volume": number }],
      "hazardousContent": [{ "type": "string", "amount": number, "content": number }],
      "annualImportByProduct": [{ "product": "string", "volume": number }],
      "highQuantityRegulations": [{ "chemical": "string", "quantity": number, "regulations": ["string"] }]
    }
    ONLY JSON. NO TEXT.`;

    const prompt = customCommand 
      ? `Perform the following specific analysis and return the results in the JSON format below.\nAnalysis Request: ${customCommand}\n\n${basePrompt}`
      : basePrompt;

    const parts: any[] = [{ text: prompt }];
    if (fileData) {
      parts.push({
        inlineData: {
          mimeType: fileData.mimeType,
          data: fileData.data
        }
      });
    } else {
      const content = tab.editedContent || tab.data;
      const truncated = content.length > 30000 ? content.substring(0, 30000) + "...[TRUNCATED]" : content;
      parts[0].text = `File:\n${truncated}\n\n${prompt}`;
    }

    try {
      const result = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      
      const data = JSON.parse(result.text || "{}");
      setTabs(prev => prev.map(t => t.id === tab.id ? { 
        ...t, 
        dashboards: t.dashboards?.map(d => d.id === dashboardId ? { ...d, data, status: 'ready' } : d)
      } : t));
    } catch (error) {
      console.error("Dashboard analysis error:", error);
      setTabs(prev => prev.map(t => t.id === tab.id ? { 
        ...t, 
        dashboards: t.dashboards?.map(d => d.id === dashboardId ? { ...d, status: 'error' } : d)
      } : t));
    }
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeTab || activeTab.isAnalyzing) return;
    
    const currentInput = input;
    setInput('');
    analyzeFile(activeTab, currentInput);
  };

  const closeTab = (id: string) => {
    setTabs(prev => prev.filter(t => t.id !== id));
    if (activeTabId === id) {
      const remainingTabs = tabs.filter(t => t.id !== id);
      setActiveTabId(remainingTabs.length > 0 ? remainingTabs[0].id : null);
    }
  };

  const updateGridCell = (rowIndex: number, colIndex: number, value: string) => {
    if (!activeTab || !activeTab.excelSheets) return;
    
    const newSheets = [...activeTab.excelSheets];
    const sheetIndex = activeTab.activeSheetIndex || 0;
    if (!newSheets[sheetIndex]) return;
    const sheetData = [...newSheets[sheetIndex].data];
    
    if (!sheetData[rowIndex]) sheetData[rowIndex] = [];
    sheetData[rowIndex][colIndex] = value;
    newSheets[sheetIndex].data = sheetData;
    
    const newCSV = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(sheetData));
    
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { 
      ...t, 
      excelSheets: newSheets,
      editedContent: newCSV 
    } : t));
  };

  const switchSheet = async (sheetIndex: number) => {
    if (!activeTab || !activeTab.excelSheets) return;
    
    const sheet = activeTab.excelSheets?.[sheetIndex];
    if (!sheet) return;
    let sheetData = sheet.data;

    // Lazy load if data is empty
    if (sheetData.length === 0) {
      const workbook = workbooksRef.current[activeTab.id];
      if (workbook) {
        try {
          const sheetName = workbook.SheetNames[sheetIndex];
          const rawSheet = workbook.Sheets[sheetName];
          sheetData = XLSX.utils.sheet_to_json(rawSheet, { header: 1 }) as string[][];
          
          // Update the tab state with the loaded data
          setTabs(prev => prev.map(t => t.id === activeTab.id ? {
            ...t,
            excelSheets: t.excelSheets?.map((s, idx) => idx === sheetIndex ? { ...s, data: sheetData } : s)
          } : t));
        } catch (e) {
          console.error("Sheet load error", e);
        }
      }
    }

    const newCSV = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(sheetData));
    setTabs(prev => prev.map(t => t.id === activeTab.id ? { 
      ...t, 
      activeSheetIndex: sheetIndex, 
      editedContent: newCSV 
    } : t));
  };

  const downloadFile = () => {
    if (!activeTab) return;
    
    let blob: Blob;
    let fileName = activeTab.name;

    if (activeTab.editorMode === 'grid' && activeTab.excelSheets) {
      const wb = XLSX.utils.book_new();
      activeTab.excelSheets.forEach(sheet => {
        const ws = XLSX.utils.aoa_to_sheet(sheet.data);
        XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      });
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      if (!fileName.endsWith('.xlsx')) fileName += '.xlsx';
    } else {
      blob = new Blob([activeTab.editedContent || activeTab.data], { type: activeTab.mimeType });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getFileIcon = (type: string) => {
    if (type === 'application/pdf') return <FileText className="w-4 h-4 text-red-400" />;
    if (type.includes('spreadsheet') || type.includes('excel') || type.includes('csv')) return <FileSpreadsheet className="w-4 h-4 text-emerald-400" />;
    if (type.includes('word') || type.includes('officedocument')) return <FileIcon className="w-4 h-4 text-blue-400" />;
    if (type.startsWith('image/')) return <Layout className="w-4 h-4 text-purple-400" />;
    return <FileIcon className="w-4 h-4 text-gray-400" />;
  };

  const addCommand = () => {
    if (newCommandInput.trim()) {
      setSavedCommands(prev => [...prev, newCommandInput.trim()]);
      setNewCommandInput('');
      setShowCommandInput(false);
    }
  };

  const deleteCommand = (index: number) => {
    setSavedCommands(prev => prev.filter((_, i) => i !== index));
  };

  const handleCommandClick = (cmd: string) => {
    if (!activeTab) return;
    generateDashboardData(activeTab, cmd);
  };

  const deleteDashboard = (id: string) => {
    if (!activeTab) return;
    setTabs(prev => prev.map(t => t.id === activeTab.id ? {
      ...t,
      dashboards: t.dashboards?.filter(d => d.id !== id),
      activeDashboardId: t.activeDashboardId === id ? t.dashboards?.filter(d => d.id !== id)[0]?.id : t.activeDashboardId
    } : t));
  };

  const copyTableToExcel = (tableHtml: string) => {
    // Basic CSV conversion from table HTML
    const rows = Array.from(document.querySelectorAll('table tr'));
    const csv = rows.map(row => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      return cells.map(cell => `"${(cell as HTMLElement).innerText.replace(/"/g, '""')}"`).join(',');
    }).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', 'analysis_table.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex h-screen w-full bg-[#050505] text-white overflow-hidden font-sans relative">
      {/* Sidebar */}
      <aside className={cn(
        "fixed inset-y-0 left-0 lg:relative w-72 border-r border-white/5 flex flex-col bg-[#080808] z-40 shrink-0 transition-transform duration-300 lg:translate-x-0",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-6 border-b border-white/5">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center">
              <span className="text-black font-bold text-xs">O</span>
            </div>
            <span className="text-sm font-medium tracking-widest uppercase opacity-50">
              RPC17_GAI <span className="text-[9px] opacity-60 ml-0.5">OFOA</span> ver01
            </span>
          </div>
          
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-3 px-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all flex items-center justify-center gap-2 group mb-2"
          >
            <Plus className="w-4 h-4 group-hover:rotate-90 transition-transform" />
            <span className="text-xs font-medium uppercase tracking-wider">New File</span>
          </button>

          <button 
            onClick={isGoogleAuthenticated ? () => setShowSheetsModal(true) : connectGoogle}
            className={cn(
              "w-full py-3 px-4 rounded-xl border transition-all flex items-center justify-center gap-2 group",
              isGoogleAuthenticated 
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20" 
                : "bg-white/5 border-white/10 hover:bg-white/10"
            )}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span className="text-xs font-medium uppercase tracking-wider">
              {isGoogleAuthenticated ? "Google Sheets" : "Connect Google"}
            </span>
          </button>
          <input 
            ref={fileInputRef}
            type="file" 
            multiple 
            className="hidden" 
            onChange={(e) => handleFileUpload(e.target.files)}
            accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,.pptx,image/*"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar min-h-0">
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-30 px-2 mb-4">Workspaces</div>
          {tabs.map((tab) => (
            <div 
              key={tab.id}
              onClick={() => {
                setActiveTabId(tab.id);
                if (window.innerWidth < 1024) setIsSidebarOpen(false);
              }}
              className={cn(
                "group relative flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all",
                activeTabId === tab.id ? "bg-white/10 border border-white/10" : "hover:bg-white/5 border border-transparent"
              )}
            >
              {getFileIcon(tab.type)}
              <span className="flex-1 text-xs font-light truncate opacity-70 group-hover:opacity-100 transition-opacity">
                {tab.name}
              </span>
              <button 
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                className="opacity-0 group-hover:opacity-40 hover:opacity-100 p-1 rounded-md hover:bg-white/10 transition-all"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-white/5">
          <div className="text-[10px] uppercase tracking-[0.2em] opacity-30 text-center">
            Created by ESP
          </div>
        </div>
      </aside>

      {/* Main Workspace */}
      <main className="flex-1 flex flex-col relative min-w-0 h-full">
        {activeTab ? (
          <>
            <header className="px-6 lg:px-8 py-4 lg:py-6 border-b border-white/5 flex items-center justify-between bg-[#050505]/80 backdrop-blur-md sticky top-0 z-10 shrink-0">
              <div className="flex items-center gap-4 min-w-0">
                <div className="p-2 rounded-lg bg-white/5 shrink-0">
                  {getFileIcon(activeTab.type)}
                </div>
                <div className="min-w-0">
                  <h1 className="text-sm font-medium tracking-wide truncate">{activeTab.name}</h1>
                  <p className="text-[10px] uppercase tracking-widest opacity-30">
                    RPC17_GAI <span className="text-[8px] opacity-60 ml-0.5">OFOA</span> Workspace
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-2 bg-white/5 p-1 rounded-xl shrink-0 ml-4">
                <button 
                  onClick={() => setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, view: 'chat' } : t))}
                  className={cn(
                    "flex items-center gap-2 px-3 lg:px-4 py-2 rounded-lg text-[10px] uppercase tracking-widest transition-all",
                    activeTab.view === 'chat' ? "bg-white text-black" : "hover:bg-white/5 opacity-40"
                  )}
                >
                  <MessageSquare className="w-3 h-3" />
                  <span className="hidden sm:inline">Analysis</span>
                </button>
                <button 
                  onClick={() => {
                    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, view: 'dashboard' } : t));
                  }}
                  className={cn(
                    "flex items-center gap-2 px-3 lg:px-4 py-2 rounded-lg text-[10px] uppercase tracking-widest transition-all",
                    activeTab.view === 'dashboard' ? "bg-white text-black" : "hover:bg-white/5 opacity-40"
                  )}
                >
                  <Layout className="w-3 h-3" />
                  <span className="hidden sm:inline">Dashboard</span>
                </button>
                <button 
                  onClick={() => setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, view: 'editor' } : t))}
                  className={cn(
                    "flex items-center gap-2 px-3 lg:px-4 py-2 rounded-lg text-[10px] uppercase tracking-widest transition-all",
                    activeTab.view === 'editor' ? "bg-white text-black" : "hover:bg-white/5 opacity-40"
                  )}
                >
                  <Edit3 className="w-3 h-3" />
                  <span className="hidden sm:inline">Editor</span>
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              {activeTab.view === 'chat' ? (
                <div className="flex-1 overflow-y-auto p-4 lg:p-8 space-y-8 custom-scrollbar min-h-0">
                  <div className="max-w-5xl mx-auto space-y-12">
                    {activeTab.messages.map((msg, idx) => (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        key={idx}
                        className={cn("flex gap-4 lg:gap-6", msg.role === 'user' ? "justify-end" : "justify-start")}
                      >
                        {msg.role === 'model' && (
                          <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0 mt-1">
                            <Sparkles className="w-4 h-4 opacity-40" />
                          </div>
                        )}
                        <div className="flex flex-col gap-2 max-w-[90%] lg:max-w-[85%]">
                          <div className={cn(
                            "rounded-2xl p-4 lg:p-6",
                            msg.role === 'user' ? "bg-white/5 border border-white/10 text-white/80" : "bg-white/5 border border-white/10 text-white/90"
                          )}>
                            <ReactMarkdown
                              components={{
                                table: ({ children }) => (
                                  <div className="relative group/table my-6">
                                    <div className="overflow-x-auto border border-white/10 rounded-xl bg-white/[0.02]">
                                      <table className="w-full text-left text-xs border-collapse">
                                        {children}
                                      </table>
                                    </div>
                                    <button 
                                      onClick={(e) => {
                                        const table = (e.currentTarget.parentElement?.querySelector('table'));
                                        if (table) {
                                          const rows = Array.from(table.querySelectorAll('tr'));
                                          const csv = rows.map(row => {
                                            const cells = Array.from(row.querySelectorAll('th, td'));
                                            return cells.map(cell => `"${(cell as HTMLElement).innerText.replace(/"/g, '""')}"`).join(',');
                                          }).join('\n');
                                          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                                          const link = document.createElement('a');
                                          link.href = URL.createObjectURL(blob);
                                          link.setAttribute('download', 'analysis_table.csv');
                                          document.body.appendChild(link);
                                          link.click();
                                          document.body.removeChild(link);
                                        }
                                      }}
                                      className="absolute -top-3 -right-3 p-2 rounded-lg bg-white text-black opacity-0 group-hover/table:opacity-100 transition-all shadow-xl flex items-center gap-2 hover:scale-105"
                                    >
                                      <FileSpreadsheet className="w-3 h-3" />
                                      <span className="text-[10px] font-bold uppercase tracking-widest">Excel</span>
                                    </button>
                                  </div>
                                ),
                                th: ({ children }) => <th className="p-4 border-b border-white/10 font-bold uppercase tracking-widest text-[10px] opacity-40">{children}</th>,
                                td: ({ children }) => <td className="p-4 border-b border-white/5 opacity-80">{children}</td>
                              }}
                            >
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                    <div ref={chatEndRef} />
                  </div>
                </div>
              ) : activeTab.view === 'dashboard' ? (
                <div className="flex-1 overflow-y-auto p-4 lg:p-8 custom-scrollbar min-h-0 bg-[#050505]">
                  {/* Command Library Header */}
                  <div className="max-w-7xl mx-auto mb-8">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
                          <History className="w-4 h-4 text-white/40" />
                        </div>
                        <h3 className="text-[10px] uppercase tracking-[0.3em] font-bold text-white/40">Command Library</h3>
                      </div>
                      <button 
                        onClick={() => setShowCommandInput(!showCommandInput)}
                        className="p-2 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                      >
                        <Plus className={cn("w-4 h-4 text-white/40 transition-transform", showCommandInput && "rotate-45")} />
                      </button>
                    </div>

                    <AnimatePresence>
                      {showCommandInput && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="mb-6 overflow-hidden"
                        >
                          <div className="flex gap-2 bg-white/5 border border-white/10 p-2 rounded-xl">
                            <input 
                              type="text"
                              value={newCommandInput}
                              onChange={(e) => setNewCommandInput(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && addCommand()}
                              placeholder="Enter a new analysis command..."
                              className="flex-1 bg-transparent border-none outline-none text-xs px-3 py-2 text-white/80"
                            />
                            <button 
                              onClick={addCommand}
                              className="px-4 py-2 bg-white text-black text-[10px] font-bold uppercase tracking-widest rounded-lg"
                            >
                              Save
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="flex flex-wrap gap-2">
                      {savedCommands.map((cmd, idx) => (
                        <div 
                          key={idx}
                          className="group flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all cursor-pointer"
                        >
                          <button 
                            onClick={() => handleCommandClick(cmd)}
                            className="text-[10px] uppercase tracking-widest font-medium text-white/60 group-hover:text-white/90"
                          >
                            {cmd}
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); deleteCommand(idx); }}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Dashboard Instances (Tabs) */}
                  {activeTab.dashboards && activeTab.dashboards.length > 0 && (
                    <div className="max-w-7xl mx-auto mb-8 flex flex-wrap gap-2 border-b border-white/5 pb-4">
                      {activeTab.dashboards.map((d) => (
                        <div 
                          key={d.id}
                          className={cn(
                            "flex items-center gap-2 px-4 py-2 rounded-xl border transition-all cursor-pointer group",
                            activeTab.activeDashboardId === d.id 
                              ? "bg-white text-black border-white" 
                              : "bg-white/5 border-white/10 hover:bg-white/10"
                          )}
                          onClick={() => setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, activeDashboardId: d.id } : t))}
                        >
                          <span className="text-[10px] font-bold uppercase tracking-widest truncate max-w-[120px]">
                            {d.command}
                          </span>
                          <button 
                            onClick={(e) => { e.stopPropagation(); deleteDashboard(d.id); }}
                            className={cn(
                              "p-1 rounded-md transition-all",
                              activeTab.activeDashboardId === d.id ? "hover:bg-black/10" : "hover:bg-white/10 opacity-40 hover:opacity-100"
                            )}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {(!activeTab.dashboards || activeTab.dashboards.length === 0) ? (
                    <div className="max-w-4xl mx-auto py-12 lg:py-20">
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-center space-y-8"
                      >
                        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[10px] uppercase tracking-[0.3em] text-white/40 mb-4">
                          <Sparkles className="w-3 h-3" />
                          Intelligence Dashboard
                        </div>
                        <h2 className="text-4xl lg:text-6xl font-light tracking-tighter leading-tight">
                          Transform your data into <br />
                          <span className="italic font-serif opacity-40">Actionable Intelligence.</span>
                        </h2>
                        <p className="text-white/30 text-sm max-w-xl mx-auto leading-relaxed">
                          Our AI engine analyzes your chemical documents to extract import volumes, hazardous compositions, and regulatory compliance patterns in seconds.
                        </p>

                        {/* Steps Section */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pt-12 max-w-3xl mx-auto">
                          {[
                            { step: '01', title: 'Select File', desc: 'Choose a document from the sidebar' },
                            { step: '02', title: 'Run AI', desc: 'Click the analysis button below' },
                            { step: '03', title: 'Visualize', desc: 'View interactive charts and tables' }
                          ].map((s, i) => (
                            <div key={i} className="text-left space-y-2">
                              <div className="text-[10px] font-bold text-white/20 tracking-widest">{s.step}</div>
                              <div className="text-xs font-bold uppercase tracking-widest">{s.title}</div>
                              <div className="text-[10px] text-white/30 leading-relaxed">{s.desc}</div>
                            </div>
                          ))}
                        </div>
                        
                        <div className="pt-12">
                          <button 
                            onClick={() => generateDashboardData(activeTab)}
                            className="px-10 py-5 rounded-2xl bg-white text-black font-bold text-xs uppercase tracking-[0.2em] hover:scale-105 transition-transform shadow-2xl shadow-white/10"
                          >
                            Start Analysis Now
                          </button>
                        </div>

                        {/* Example Preview */}
                        <div className="pt-24 space-y-8">
                          <div className="text-[10px] uppercase tracking-[0.3em] text-white/20 font-bold">Example Dashboard Layout</div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 opacity-10 hover:opacity-20 transition-opacity cursor-default select-none">
                          {[
                            { label: 'Import Trends', type: 'Bar Chart' },
                            { label: 'Risk Analysis', type: 'Pie Chart' },
                            { label: 'Compliance', type: 'Data Table' }
                          ].map((ex, i) => (
                            <div key={i} className="bg-white/5 border border-white/10 rounded-2xl p-6 text-left space-y-4">
                              <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                                <Layout className="w-4 h-4" />
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-widest opacity-50">{ex.type}</div>
                                <div className="text-sm font-medium">{ex.label}</div>
                              </div>
                              <div className="h-20 w-full bg-white/5 rounded-lg flex items-end gap-1 p-2">
                                {[40, 70, 45, 90, 60].map((h, j) => (
                                  <div key={j} className="flex-1 bg-white/10 rounded-sm" style={{ height: `${h}%` }} />
                                ))}
                              </div>
                            </div>
                          ))}
                          </div>
                        </div>
                      </motion.div>
                    </div>
                  ) : (
                    (() => {
                      const activeDashboard = activeTab.dashboards?.find(d => d.id === activeTab.activeDashboardId);
                      if (!activeDashboard) return null;

                      if (activeDashboard.status === 'loading') {
                        return (
                          <div className="h-full flex flex-col items-center justify-center space-y-6 py-20">
                            <div className="relative">
                              <Loader2 className="w-12 h-12 animate-spin text-white/20" />
                              <Sparkles className="w-6 h-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-40 animate-pulse" />
                            </div>
                            <div className="text-center space-y-2">
                              <p className="text-sm font-medium uppercase tracking-[0.3em] text-white/40">Analyzing Intelligence</p>
                              <p className="text-[10px] uppercase tracking-widest text-white/20">Synthesizing chemical data and regulatory patterns...</p>
                            </div>
                          </div>
                        );
                      }

                      if (activeDashboard.status === 'error') {
                        return (
                          <div className="h-full flex flex-col items-center justify-center space-y-4 py-20">
                            <X className="w-12 h-12 text-red-400/20" />
                            <p className="text-xs uppercase tracking-[0.3em] opacity-40">Analysis Failed</p>
                          </div>
                        );
                      }

                      const dashboardData = activeDashboard.data;
                      if (!dashboardData) return null;

                      return (
                        <div className="max-w-7xl mx-auto space-y-10 pb-20">
                      {/* Summary Stats */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {[
                              { label: 'Total Volume', value: dashboardData.summary?.totalVolume?.toLocaleString() || '0', unit: 'kg', icon: <Download className="w-4 h-4" /> },
                              { label: 'Hazardous Substances', value: dashboardData.summary?.hazardousCount || '0', unit: 'types', icon: <Trash2 className="w-4 h-4" /> },
                              { label: 'Active Regulations', value: dashboardData.summary?.regulationCount || '0', unit: 'items', icon: <Save className="w-4 h-4" /> },
                              { label: 'Primary Chemical', value: dashboardData.summary?.topChemical || 'N/A', unit: '', icon: <FileText className="w-4 h-4" /> },
                        ].map((stat, i) => (
                          <motion.div 
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.1 }}
                            key={i} 
                            className="bg-white/[0.03] border border-white/5 rounded-2xl p-5 hover:bg-white/[0.05] transition-colors group"
                          >
                            <div className="flex items-center justify-between mb-4">
                              <div className="p-2 rounded-lg bg-white/5 text-white/40 group-hover:text-white/60 transition-colors">
                                {stat.icon}
                              </div>
                              <div className="text-[10px] uppercase tracking-widest opacity-30 font-bold">Overview</div>
                            </div>
                            <div className="space-y-1">
                              <div className="text-2xl font-light tracking-tighter flex items-baseline gap-1">
                                {stat.value}
                                <span className="text-[10px] uppercase tracking-widest opacity-30 font-bold">{stat.unit}</span>
                              </div>
                              <div className="text-[10px] uppercase tracking-widest opacity-40">{stat.label}</div>
                            </div>
                          </motion.div>
                        ))}
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        {/* Annual Import by Chemical */}
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          className="lg:col-span-8 bg-white/[0.02] border border-white/5 rounded-3xl p-8 relative overflow-hidden group"
                        >
                          <div className="absolute top-0 right-0 p-8 opacity-[0.02] group-hover:opacity-[0.05] transition-opacity">
                            <BarChart className="w-32 h-32" />
                          </div>
                          <div className="relative">
                            <div className="flex items-center justify-between mb-10">
                              <div>
                                <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 mb-1">Annual Import Analysis</h3>
                                <p className="text-[10px] uppercase tracking-widest text-white/20">Volume distribution by chemical substance</p>
                              </div>
                              <div className="flex gap-2">
                                <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                                <div className="w-2 h-2 rounded-full bg-white/20" />
                              </div>
                            </div>
                            <div className="h-[350px] w-full">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={dashboardData.annualImportByChemical} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                                  <defs>
                                    <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                                      <stop offset="0%" stopColor="rgba(255,255,255,0.8)" />
                                      <stop offset="100%" stopColor="rgba(255,255,255,0.1)" />
                                    </linearGradient>
                                  </defs>
                                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                                  <XAxis 
                                    dataKey="name" 
                                    stroke="rgba(255,255,255,0.2)" 
                                    fontSize={9} 
                                    tickLine={false} 
                                    axisLine={false} 
                                    dy={10}
                                    interval={0}
                                  />
                                  <YAxis stroke="rgba(255,255,255,0.2)" fontSize={9} tickLine={false} axisLine={false} />
                                  <Tooltip 
                                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                                    contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px' }}
                                    itemStyle={{ color: '#fff', fontSize: '11px', fontWeight: 'bold' }}
                                    labelStyle={{ color: 'rgba(255,255,255,0.4)', fontSize: '9px', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '1px' }}
                                  />
                                  <Bar dataKey="volume" fill="url(#barGradient)" radius={[6, 6, 0, 0]} barSize={40} animationDuration={1500} />
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </motion.div>

                        {/* Hazardous Content */}
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: 0.1 }}
                          className="lg:col-span-4 bg-white/[0.02] border border-white/5 rounded-3xl p-8 flex flex-col"
                        >
                          <div className="mb-10">
                            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 mb-1">Hazardous Composition</h3>
                            <p className="text-[10px] uppercase tracking-widest text-white/20">Risk factor distribution</p>
                          </div>
                          <div className="flex-1 h-[300px] w-full relative">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie
                                  data={dashboardData.hazardousContent}
                                  cx="50%"
                                  cy="50%"
                                  innerRadius={70}
                                  outerRadius={95}
                                  paddingAngle={8}
                                  dataKey="amount"
                                  nameKey="type"
                                  stroke="none"
                                >
                                  {dashboardData.hazardousContent?.map((_: any, index: number) => (
                                    <Cell key={`cell-${index}`} fill={index === 0 ? '#fff' : index === 1 ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.1)'} />
                                  ))}
                                </Pie>
                                <Tooltip 
                                  contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                                  itemStyle={{ color: '#fff', fontSize: '11px' }}
                                />
                              </PieChart>
                            </ResponsiveContainer>
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
                              <div className="text-2xl font-light tracking-tighter">{dashboardData.hazardousContent?.length || 0}</div>
                              <div className="text-[8px] uppercase tracking-widest opacity-30 font-bold">Types</div>
                            </div>
                          </div>
                          <div className="mt-6 space-y-3">
                            {dashboardData.hazardousContent?.slice(0, 3).map((item: any, i: number) => (
                              <div key={i} className="flex items-center justify-between text-[10px] uppercase tracking-widest">
                                <div className="flex items-center gap-2">
                                  <div className={cn("w-1.5 h-1.5 rounded-full", i === 0 ? "bg-white" : i === 1 ? "bg-white/40" : "bg-white/10")} />
                                  <span className="opacity-40 truncate max-w-[120px]">{item.type}</span>
                                </div>
                                <span className="font-bold">{item.content}%</span>
                              </div>
                            ))}
                          </div>
                        </motion.div>

                        {/* Annual Import by Product */}
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: 0.2 }}
                          className="lg:col-span-5 bg-white/[0.02] border border-white/5 rounded-3xl p-8"
                        >
                          <div className="mb-10">
                            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 mb-1">Product Distribution</h3>
                            <p className="text-[10px] uppercase tracking-widest text-white/20">Import volume by product category</p>
                          </div>
                          <div className="h-[350px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                              <BarChart data={dashboardData.annualImportByProduct} layout="vertical" margin={{ top: 0, right: 30, left: 20, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" horizontal={false} />
                                <XAxis type="number" stroke="rgba(255,255,255,0.2)" fontSize={9} tickLine={false} axisLine={false} />
                                <YAxis dataKey="product" type="category" stroke="rgba(255,255,255,0.2)" fontSize={9} tickLine={false} axisLine={false} width={80} />
                                <Tooltip 
                                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                                  contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                                  itemStyle={{ color: '#fff', fontSize: '11px' }}
                                />
                                <Bar dataKey="volume" fill="rgba(255,255,255,0.15)" radius={[0, 4, 4, 0]} barSize={16} />
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </motion.div>

                        {/* High Quantity Regulations Table */}
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.98 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: 0.3 }}
                          className="lg:col-span-7 bg-white/[0.02] border border-white/5 rounded-3xl p-8 overflow-hidden flex flex-col"
                        >
                          <div className="mb-8 flex items-center justify-between">
                            <div>
                              <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-white/50 mb-1">Regulatory Compliance</h3>
                              <p className="text-[10px] uppercase tracking-widest text-white/20">High-volume substance monitoring</p>
                            </div>
                            <div className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[9px] uppercase tracking-widest opacity-40">
                              Live Status
                            </div>
                          </div>
                          <div className="flex-1 overflow-auto custom-scrollbar">
                            <table className="w-full text-left text-[11px]">
                              <thead>
                                <tr className="border-b border-white/5">
                                  <th className="pb-4 font-bold uppercase tracking-[0.15em] opacity-20 text-[9px]">Substance</th>
                                  <th className="pb-4 font-bold uppercase tracking-[0.15em] opacity-20 text-[9px]">Volume</th>
                                  <th className="pb-4 font-bold uppercase tracking-[0.15em] opacity-20 text-[9px]">Regulations</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/[0.03]">
                                {dashboardData.highQuantityRegulations?.map((item: any, idx: number) => (
                                  <tr key={idx} className="group hover:bg-white/[0.02] transition-colors">
                                    <td className="py-5 pr-4">
                                      <div className="font-medium text-white/80 group-hover:text-white transition-colors">{item.chemical}</div>
                                      <div className="text-[9px] opacity-20 uppercase tracking-widest mt-0.5">Chemical ID: {Math.random().toString(36).substring(7).toUpperCase()}</div>
                                    </td>
                                    <td className="py-5">
                                      <span className="font-mono text-white/40">{item.quantity?.toLocaleString()}</span>
                                    </td>
                                    <td className="py-5">
                                      <div className="flex flex-wrap gap-1.5">
                                        {item.regulations?.map((reg: string, rIdx: number) => (
                                          <span key={rIdx} className="px-2 py-1 rounded-md bg-white/5 border border-white/5 text-[8px] uppercase tracking-widest text-white/40 group-hover:text-white/60 transition-colors">
                                            {reg}
                                          </span>
                                        ))}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          </motion.div>
                        </div>
                      </div>
                    )
                  })()
                )}
              </div>
            ) : (
                <div className="flex-1 p-4 lg:p-8 overflow-hidden flex flex-col min-h-0">
                  <div className="flex-1 bg-[#0a0a0a] border border-white/10 rounded-2xl overflow-hidden flex flex-col min-h-0 relative">
                    {activeTab.editorMode === 'grid' && activeTab.excelSheets && (
                      <div className="flex items-center justify-between px-4 py-2 bg-[#141414] border-b border-white/10 shrink-0">
                        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                          {activeTab.excelSheets.map((sheet, idx) => (
                            <button
                              key={idx}
                              onClick={() => switchSheet(idx)}
                              className={cn(
                                "px-4 py-1.5 rounded-lg text-[10px] uppercase tracking-widest transition-all whitespace-nowrap",
                                (activeTab.activeSheetIndex || 0) === idx 
                                  ? "bg-white/10 text-white font-bold border border-white/20" 
                                  : "text-white/40 hover:bg-white/5"
                              )}
                            >
                              {sheet.name}
                            </button>
                          ))}
                        </div>
                        <button 
                          onClick={downloadFile}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all border border-emerald-500/20 ml-4"
                        >
                          <Download className="w-3 h-3" />
                          <span className="text-[9px] font-bold uppercase tracking-widest">Export</span>
                        </button>
                      </div>
                    )}
                    {activeTab.editorMode === 'grid' && activeTab.excelSheets ? (
                      <div className="flex-1 overflow-auto custom-scrollbar relative">
                        <table className="w-full border-separate border-spacing-0 text-[11px] font-mono">
                          <thead>
                            <tr className="bg-[#141414]">
                              <th className="w-12 h-8 sticky top-0 left-0 z-30 bg-[#1a1a1a] border-b border-r border-white/10"></th>
                              {activeTab.excelSheets?.[activeTab.activeSheetIndex || 0]?.data?.[0]?.map((_, cIdx) => (
                                <th key={cIdx} className="min-w-[120px] h-8 sticky top-0 z-20 bg-[#141414] border-b border-r border-white/10 p-0 relative">
                                  <div className="flex items-center justify-center h-full px-2">
                                    <span className="opacity-40 font-bold">{String.fromCharCode(65 + cIdx)}</span>
                                  </div>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {activeTab.excelSheets?.[activeTab.activeSheetIndex || 0]?.data?.slice(0, 100).map((row, rIdx) => (
                              <tr key={rIdx}>
                                <td className="w-12 h-8 sticky left-0 z-10 bg-[#141414] border-b border-r border-white/10 text-center">
                                  <span className="opacity-40 font-bold">{rIdx + 1}</span>
                                </td>
                                {row.map((cell, cIdx) => (
                                  <td key={cIdx} className="border-b border-r border-white/5 p-0">
                                    <input 
                                      type="text"
                                      value={cell || ''}
                                      onChange={(e) => updateGridCell(rIdx, cIdx, e.target.value)}
                                      className="w-full h-8 bg-transparent px-3 outline-none focus:bg-white/5 focus:ring-1 focus:ring-white/20 transition-all"
                                    />
                                  </td>
                                ))}
                              </tr>
                            ))}
                            {(activeTab.excelSheets?.[activeTab.activeSheetIndex || 0]?.data?.length || 0) > 100 && (
                              <tr>
                                <td colSpan={100} className="p-8 text-center text-white/20 uppercase tracking-[0.2em] text-[10px]">
                                  Preview limited to 100 rows for performance. Use Export to see full data.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    ) : activeTab.type === 'application/pdf' ? (
                      <iframe 
                        src={`data:application/pdf;base64,${activeTab.data}`}
                        className="w-full h-full border-none bg-white"
                        title="PDF Preview"
                      />
                    ) : activeTab.type.startsWith('image/') ? (
                      <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
                        <img 
                          src={`data:${activeTab.type};base64,${activeTab.data}`} 
                          alt="Preview" 
                          className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                        />
                      </div>
                    ) : (
                      <textarea 
                        value={activeTab.editedContent || activeTab.data}
                        onChange={(e) => {
                          const val = e.target.value;
                          setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, editedContent: val } : t));
                        }}
                        className="flex-1 w-full h-full bg-transparent p-8 outline-none text-sm font-mono leading-relaxed resize-none custom-scrollbar"
                        spellCheck={false}
                      />
                )}
              </div>
            </div>
          )}
        </div>

            {activeTab.view === 'chat' && (
              <div className="p-4 lg:p-8 bg-gradient-to-t from-[#050505] via-[#050505] to-transparent shrink-0">
                <form onSubmit={handleSendMessage} className="max-w-5xl mx-auto relative group">
                  <div className="relative flex items-center bg-white/5 border border-white/10 rounded-2xl p-2 focus-within:border-white/20 transition-all">
                    <input 
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={`Ask the AI about ${activeTab.name}...`}
                      className="flex-1 bg-transparent border-none outline-none py-3 lg:py-4 px-4 lg:px-6 text-sm font-light placeholder:text-white/10"
                    />
                    <button 
                      id="chat-send-button"
                      disabled={!input.trim() || activeTab.isAnalyzing}
                      className="p-3 rounded-xl bg-white text-black disabled:bg-white/10 disabled:text-white/20 transition-all"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </form>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center max-w-md">
              <div className="w-20 h-20 lg:w-24 lg:h-24 rounded-3xl bg-white/5 flex items-center justify-center mx-auto mb-8 lg:mb-12 animate-float">
                <Upload className="w-8 h-8 lg:w-10 lg:h-10 opacity-20" />
              </div>
              <h2 className="text-3xl lg:text-4xl font-light tracking-tighter mb-6">RPC17_GAI ver01.<br /><span className="italic font-serif opacity-40 text-4xl lg:text-5xl">One File One AI.</span></h2>
              <p className="text-white/30 text-sm leading-relaxed mb-4">Created by ESP</p>
              <p className="text-white/30 text-sm leading-relaxed mb-8 lg:mb-12">Upload a document to assign a specialized AI agent to it. Edit, analyze, and manage your data.</p>
              <button onClick={() => fileInputRef.current?.click()} className="px-8 py-4 rounded-2xl bg-white text-black font-medium text-sm uppercase tracking-widest hover:scale-105 transition-transform">Select Files to Begin</button>
            </motion.div>
          </div>
        )}
      </main>

      {/* Google Sheets Modal */}
      <AnimatePresence>
        {showSheetsModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSheetsModal(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-xl bg-[#0a0a0a] border border-white/10 rounded-3xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-[0.2em]">Google Sheets</h2>
                  <p className="text-[10px] opacity-40 uppercase tracking-widest mt-1">Select a spreadsheet to import</p>
                </div>
                <button onClick={() => setShowSheetsModal(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {isLoadingSheets ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-4">
                    <Loader2 className="w-6 h-6 animate-spin opacity-20" />
                    <span className="text-[10px] uppercase tracking-widest opacity-20">Loading your sheets...</span>
                  </div>
                ) : spreadsheets.length > 0 ? (
                  spreadsheets.map((sheet) => (
                    <div 
                      key={sheet.id}
                      onClick={() => importSpreadsheet(sheet.id)}
                      className="group flex items-center gap-4 p-4 rounded-2xl bg-white/5 border border-transparent hover:border-white/10 hover:bg-white/[0.08] cursor-pointer transition-all"
                    >
                      <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
                        <FileSpreadsheet className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{sheet.name}</div>
                        <div className="text-[9px] opacity-30 uppercase tracking-widest mt-1">
                          Modified {new Date(sheet.modifiedTime).toLocaleDateString()}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 opacity-0 group-hover:opacity-40 transition-all" />
                    </div>
                  ))
                ) : (
                  <div className="text-center py-20 opacity-30 text-[10px] uppercase tracking-widest">
                    No spreadsheets found
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.05); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.1); }
      `}} />
    </div>
  );
}
